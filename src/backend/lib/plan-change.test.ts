import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { runNetworkEnforcement } from './network-enforcement';
import {
  cancelPlanChange, createPlanChangeBatch, loadPlanChange, PlanChangeBlocked, previewPlanChange, recoverInterruptedPlanChanges,
  runDueSessionDrops, runPlanChangeBatch, uptimeSeconds, type DropMode, type RouterSnapshot
} from './plan-change';
import { RouterError, type RouterRequest, type RouterSecret, type RouterTransport } from './routeros';
import { writePppoeSecret } from './secrets';

const admin = { user: { id: 7, username: 'ana', fullName: 'Ana', role: 'admin' } } as never;
const login = (id: number) => `skn${String(id).padStart(3, '0')}`;

/** Um router em memória. `onWrite` deixa um teste falhar, cortar ou cancelar a meio. */
function fakeRouter(count: number, options: { online?: number[]; profiles?: string[]; uptime?: string } = {}) {
  const secrets: RouterSecret[] = Array.from({ length: count }, (_, index) => ({
    id: `*${index + 1}`, name: login(index + 1), disabled: false, profile: 'plano-10M', comment: `ispm:${index + 1} Cliente ${String(index + 1).padStart(2, '0')}`
  }));
  const sessions = (options.online ?? []).map((id) => ({ id: `*S${id}`, name: login(id), uptime: options.uptime ?? '5h' }));
  const profiles = options.profiles ?? ['default', 'plano-10M', 'plano-20M', 'SUSPENSO'];
  const calls: RouterRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let onWrite: ((req: RouterRequest, index: number) => void) | null = null;
  let writeIndex = 0;

  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (req.path.startsWith('/ppp/profile?')) return profiles.map((name, index) => ({ '.id': `*P${index}`, name }));
      if (req.path.startsWith('/ppp/secret?')) {
        return secrets.map((s) => ({ '.id': s.id, name: s.name, disabled: String(s.disabled), profile: s.profile ?? undefined, comment: s.comment ?? undefined }));
      }
      if (req.path.startsWith('/ppp/active?')) return sessions.map((s) => ({ '.id': s.id, name: s.name, uptime: s.uptime }));
      if (req.method !== 'GET') onWrite?.(req, writeIndex++);
      if (req.method === 'PATCH') {
        const target = secrets.find((s) => s.id === req.path.slice('/ppp/secret/'.length))!;
        const body = req.body as { profile?: string };
        if (body.profile !== undefined) target.profile = body.profile;
      }
      if (req.method === 'DELETE') sessions.splice(sessions.findIndex((s) => s.id === req.path.slice('/ppp/active/'.length)), 1);
      return null;
    } finally {
      inFlight -= 1;
    }
  }) as RouterTransport;

  return {
    transport, calls, secrets, sessions,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    maxInFlight: () => maxInFlight,
    onWrite: (handler: typeof onWrite) => { onWrite = handler; writeIndex = 0; },
    snapshot: (): RouterSnapshot => ({
      secrets: secrets.map((s) => ({ ...s })),
      active: sessions.map((s) => ({ id: s.id, name: s.name, address: null, uptime: s.uptime, callerId: null })),
      profiles: [...profiles]
    })
  };
}

let db: Database.Database;

function seed(count: number, status: (id: number) => string = () => 'active') {
  for (let id = 1; id <= count; id += 1) {
    db.prepare(`INSERT INTO clients (id, client_code, full_name, phone) VALUES (?, ?, ?, ?)`)
      .run(id, `C${String(id).padStart(4, '0')}`, `Cliente ${String(id).padStart(2, '0')}`, `9${String(id).padStart(6, '0')}`);
    db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (?, ?, 1, 2500, ?, ?)`)
      .run(id, id, status(id), login(id));
    writePppoeSecret(db, id, 'senha');
  }
}

const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const service = (id: number) => db.prepare('SELECT plan_id AS planId, monthly_value_cve AS value, status FROM services WHERE id = ?').get(id) as
  { planId: number; value: number; status: string };
const itemStatuses = (batchId: number) => (loadPlanChange(db, batchId)!.items as Array<{ status: string }>).map((item) => item.status);

async function change(
  router: ReturnType<typeof fakeRouter>,
  serviceIds: number[],
  options: { dropMode?: DropMode; dropAt?: string; dryRun?: boolean; updatePrice?: boolean; now?: Date } = {}
) {
  const dryRun = options.dryRun ?? false;
  const snapshot = router.snapshot();
  const batchId = createPlanChangeBatch(db, {
    serviceIds, targetPlanId: 2, updatePrice: options.updatePrice ?? true, reason: 'Campanha de outubro',
    dropMode: options.dropMode ?? 'none', dropAt: options.dropAt
  }, snapshot, { dryRun, actor: admin, now: options.now });
  const status = await runPlanChangeBatch(db, { transport: router.transport, dryRun, pauseMs: 0, now: options.now ? () => options.now! : undefined }, batchId, snapshot, admin);
  return { batchId, status, batch: loadPlanChange(db, batchId)! };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`
    INSERT INTO internet_plans (id, name, monthly_price_cve, router_profile)
    VALUES (1, 'Base 10', 2500, 'plano-10M'), (2, 'Mais 20', 3500, 'plano-20M')
  `).run();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7, 'ana', 'x', 'admin', 'Ana')`).run();
});

describe('previewPlanChange', () => {
  test('agrupa por plano de origem e mostra antes → depois, quem está ligado e quem fica de fora', () => {
    seed(4, (id) => (id === 3 ? 'suspended' : id === 4 ? 'cancelled' : 'active'));
    db.prepare(`INSERT INTO internet_plans (id, name, monthly_price_cve, router_profile) VALUES (3, 'Antigo 5', 1500, 'plano-10M')`).run();
    db.prepare('UPDATE services SET plan_id = 3 WHERE id = 2').run();
    const router = fakeRouter(4, { online: [1, 3] });

    const preview = previewPlanChange(db, { serviceIds: ids(4), targetPlanId: 2, updatePrice: true }, router.snapshot(), { dryRun: false });

    expect(preview.blockers).toEqual([]);
    expect(preview.groups).toEqual([{ planName: 'Base 10', count: 2 }, { planName: 'Antigo 5', count: 1 }]);
    expect(preview.toChange).toBe(3);
    expect(preview.sessionsOnline).toBe(1);
    expect(preview.rows.map((row) => [row.serviceId, row.outcome])).toEqual([[1, 'change'], [2, 'change'], [3, 'suspended'], [4, 'cancelled']]);
    expect(preview.rows[0]).toMatchObject({
      fromPlanName: 'Base 10', fromValueCve: 2500, toValueCve: 3500, fromProfile: 'plano-10M', toProfile: 'plano-20M', online: true
    });
    // O suspenso muda de plano no ISPM mas no router fica onde está.
    expect(preview.rows[2]).toMatchObject({ toProfile: 'SUSPENSO', routerChange: false });
    expect(router.writes()).toEqual([]);
  });

  test('a mensalidade só acompanha se for pedido', () => {
    seed(1);
    const preview = previewPlanChange(db, { serviceIds: [1], targetPlanId: 2, updatePrice: false }, fakeRouter(1).snapshot(), { dryRun: false });
    expect(preview.rows[0]).toMatchObject({ fromValueCve: 2500, toValueCve: 2500, outcome: 'change' });
  });

  test('diz o que impede: perfil que não existe no router, router por ler, nada a mudar', () => {
    seed(1);
    const input = { serviceIds: [1], targetPlanId: 2, updatePrice: true };
    expect(previewPlanChange(db, input, fakeRouter(1, { profiles: ['default', 'plano-10M'] }).snapshot(), { dryRun: false }).blockers)
      .toEqual([expect.stringContaining('plano-20M do plano Mais 20 não existe no router')]);
    expect(previewPlanChange(db, input, null, { dryRun: false, routerIssue: 'Fora da rede de gestão.' }).blockers)
      .toEqual(['Fora da rede de gestão.']);
    expect(previewPlanChange(db, { ...input, targetPlanId: 99 }, fakeRouter(1).snapshot(), { dryRun: false }).blockers)
      .toEqual(['O plano de destino não existe.']);
    expect(previewPlanChange(db, { ...input, targetPlanId: 1 }, fakeRouter(1).snapshot(), { dryRun: false }).blockers)
      .toEqual([expect.stringContaining('Nenhum dos serviços escolhidos muda')]);
  });
});

describe('mudança de plano em massa', () => {
  test('muda 15 clientes numa só operação, em série, sem derrubar ninguém', async () => {
    seed(15);
    const router = fakeRouter(15, { online: [1, 2, 3] });

    const { status, batch } = await change(router, ids(15));

    expect(status).toBe('done');
    expect(batch.counts).toMatchObject({ applied: 15, failed: 0, not_processed: 0, queued: 0, pending: 0 });
    expect(router.secrets.every((secret) => secret.profile === 'plano-20M')).toBe(true);
    expect(ids(15).every((id) => service(id).planId === 2 && service(id).value === 3500)).toBe(true);
    // Por omissão nenhuma sessão cai: só PATCH, um por cliente, nunca dois ao mesmo tempo.
    expect(router.writes().map((call) => call.method)).toEqual(Array(15).fill('PATCH'));
    expect(router.sessions).toHaveLength(3);
    expect(router.maxInFlight()).toBe(1);
  });

  test('cada alteração fica na auditoria: quem, de que plano para qual, e o resultado', async () => {
    seed(2);
    const { batchId } = await change(fakeRouter(2), [1, 2]);

    const audits = db.prepare(`SELECT actor_username AS actor, entity_id AS entity, summary, metadata_json AS meta FROM audit_logs WHERE action = 'plan_change' ORDER BY id`).all() as
      Array<{ actor: string; entity: string; summary: string; meta: string }>;
    expect(audits.map((row) => [row.actor, row.entity])).toEqual([['ana', '1'], ['ana', '2']]);
    expect(audits[0].summary).toBe('Cliente 01 passou do plano Base 10 para Mais 20');
    expect(JSON.parse(audits[0].meta)).toMatchObject({ batchId, fromPlan: 'Base 10', toPlan: 'Mais 20', result: 'applied', sessionDropped: false });

    // E o lote guarda o porquê, para quem perguntar daqui a seis meses.
    expect(loadPlanChange(db, batchId)).toMatchObject({ reason: 'Campanha de outubro', createdByName: 'ana', targetPlanName: 'Mais 20', dropMode: 'none' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'plan_change_batch'`).get()).toEqual({ n: 1 });
  });

  test('falha a meio: só esse volta atrás, com o erro; os outros seguem', async () => {
    seed(5);
    const router = fakeRouter(5);
    router.onWrite((_req, index) => { if (index === 2) throw new RouterError('Bad Request: input does not match any value of profile', 400); });

    const { status, batch, batchId } = await change(router, ids(5));

    expect(status).toBe('done');
    expect(itemStatuses(batchId)).toEqual(['applied', 'applied', 'failed', 'applied', 'applied']);
    expect(batch.counts).toMatchObject({ applied: 4, failed: 1 });
    expect((batch.items as Array<{ error: string | null }>)[2].error).toContain('input does not match');
    expect(service(3)).toMatchObject({ planId: 1, value: 2500 });
    expect(service(4)).toMatchObject({ planId: 2, value: 3500 });
    expect(router.secrets[2].profile).toBe('plano-10M');
    expect(db.prepare(`SELECT summary FROM audit_logs WHERE action = 'plan_change' AND entity_id = '3'`).get())
      .toEqual({ summary: expect.stringContaining('Falhou a mudança de Cliente 03') });
  });

  test('router inacessível a meio: pára, repõe o que estava em curso e não toca no resto', async () => {
    seed(6);
    const router = fakeRouter(6);
    router.onWrite((_req, index) => { if (index >= 2) throw new RouterError('connect ETIMEDOUT', 0, undefined, 'ETIMEDOUT'); });

    const { status, batch, batchId } = await change(router, ids(6));

    expect(status).toBe('stopped');
    expect(batch).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('deixou de responder') });
    expect(itemStatuses(batchId)).toEqual(['applied', 'applied', 'failed', 'not_processed', 'not_processed', 'not_processed']);
    expect(ids(6).map((id) => service(id).planId)).toEqual([2, 2, 1, 1, 1, 1]);
    // Tentou uma vez e parou: não continuou às cegas.
    expect(router.writes()).toHaveLength(3);
  });

  test('plano que não existe no router é recusado antes de qualquer escrita', async () => {
    seed(3);
    const router = fakeRouter(3, { profiles: ['default', 'plano-10M'] });

    expect(() => createPlanChangeBatch(db, { serviceIds: ids(3), targetPlanId: 2, updatePrice: true, dropMode: 'none' }, router.snapshot(), { dryRun: false, actor: admin }))
      .toThrow(PlanChangeBlocked);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_change_batches').get()).toEqual({ n: 0 });
    expect(ids(3).every((id) => service(id).planId === 1)).toBe(true);
    expect(router.writes()).toEqual([]);
  });

  test('repetir a mesma operação não faz nada', async () => {
    seed(4);
    const router = fakeRouter(4);
    await change(router, ids(4));
    router.calls.length = 0;
    const auditsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'plan_change'`).get() as { n: number }).n;

    // Com todos já no destino a operação nem começa…
    expect(() => createPlanChangeBatch(db, { serviceIds: ids(4), targetPlanId: 2, updatePrice: true, dropMode: 'none' }, router.snapshot(), { dryRun: false, actor: admin }))
      .toThrow(/Nenhum dos serviços escolhidos muda/);

    // …e misturados com um que falta, só esse é tocado.
    db.prepare('UPDATE services SET plan_id = 1, monthly_value_cve = 2500 WHERE id = 4').run();
    router.secrets[3].profile = 'plano-10M';
    const { batchId } = await change(router, ids(4));

    expect(itemStatuses(batchId)).toEqual(['unchanged', 'unchanged', 'unchanged', 'applied']);
    expect(router.writes()).toEqual([{ method: 'PATCH', path: '/ppp/secret/*4', body: { profile: 'plano-20M' } }]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'plan_change'`).get() as { n: number }).n).toBe(auditsBefore + 1);
  });

  test('derrubar agora só derruba quem está ligado, e regista-o', async () => {
    seed(3);
    const router = fakeRouter(3, { online: [2] });

    const { batch } = await change(router, ids(3), { dropMode: 'now' });

    expect(router.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      'PATCH /ppp/secret/*1', 'PATCH /ppp/secret/*2', 'DELETE /ppp/active/*S2', 'PATCH /ppp/secret/*3'
    ]);
    expect((batch.items as Array<{ sessionDroppedAt: string | null }>).map((item) => Boolean(item.sessionDroppedAt))).toEqual([false, true, false]);
    expect(JSON.parse((db.prepare(`SELECT metadata_json AS meta FROM audit_logs WHERE action = 'plan_change' AND entity_id = '2'`).get() as { meta: string }).meta))
      .toMatchObject({ sessionDropped: true });
  });

  test('um suspenso muda de plano no ISPM e não é reativado', async () => {
    seed(2, (id) => (id === 2 ? 'suspended' : 'active'));
    const router = fakeRouter(2, { online: [2] });
    router.secrets[1].profile = 'SUSPENSO';

    const { batch } = await change(router, [1, 2], { dropMode: 'now' });

    expect(service(2)).toMatchObject({ planId: 2, status: 'suspended' });
    expect(router.secrets[1]).toMatchObject({ profile: 'SUSPENSO', disabled: false });
    expect(router.writes()).toEqual([{ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'plano-20M' } }]);
    expect((batch.items as Array<{ status: string; note: string | null }>)[1]).toMatchObject({ status: 'applied', note: expect.stringContaining('Suspenso') });

    // A reconciliação também não o repõe: continua suspenso depois da passagem.
    await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
    expect(router.secrets[1].profile).toBe('SUSPENSO');
  });

  test('sem secret no router: reporta e não cria nada', async () => {
    seed(2);
    const router = fakeRouter(2);
    router.secrets.pop();

    const { batch } = await change(router, [1, 2]);

    expect((batch.items as Array<{ status: string; note: string | null }>)[1]).toMatchObject({ status: 'applied', note: expect.stringContaining('não tem este utilizador') });
    expect(service(2).planId).toBe(2);
    expect(router.writes().every((call) => call.method === 'PATCH')).toBe(true);
    expect(router.secrets).toHaveLength(1);
  });

  test('cancelar a meio: os já processados ficam alterados, o resto fica por processar', async () => {
    seed(5);
    const router = fakeRouter(5);
    router.onWrite((_req, index) => {
      if (index === 1) cancelPlanChange(db, 1);
    });

    const { status, batchId } = await change(router, ids(5));

    expect(status).toBe('cancelled');
    expect(itemStatuses(batchId)).toEqual(['applied', 'applied', 'not_processed', 'not_processed', 'not_processed']);
    expect(ids(5).map((id) => service(id).planId)).toEqual([2, 2, 1, 1, 1]);
    expect(loadPlanChange(db, batchId)).toMatchObject({ status: 'cancelled', stopReason: 'Cancelado pelo operador.' });
  });

  test('em ensaio muda só o ISPM e di-lo em cada item', async () => {
    seed(2);
    const router = fakeRouter(2);

    const { batch } = await change(router, [1, 2], { dryRun: true, dropMode: 'now' });

    expect(router.writes()).toEqual([]);
    expect(service(1).planId).toBe(2);
    expect(batch).toMatchObject({ dryRun: 1 });
    expect((batch.items as Array<{ note: string | null }>)[0].note).toContain('Ensaio');
  });

  test('o perfil novo fica como acordo: a reconciliação não o reescreve nem o vê como desvio', async () => {
    seed(2);
    const router = fakeRouter(2);
    await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
    await change(router, [1, 2]);
    router.calls.length = 0;

    const summary = await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });

    expect(router.writes()).toEqual([]);
    expect(summary.divergences).toBe(0);
  });

  test('só um lote de cada vez', async () => {
    seed(2);
    const router = fakeRouter(2);
    createPlanChangeBatch(db, { serviceIds: [1], targetPlanId: 2, updatePrice: true, dropMode: 'none' }, router.snapshot(), { dryRun: false, actor: admin });
    expect(() => createPlanChangeBatch(db, { serviceIds: [2], targetPlanId: 2, updatePrice: true, dropMode: 'none' }, router.snapshot(), { dryRun: false, actor: admin }))
      .toThrow(/Já há uma mudança de plano em curso/);
  });

  test('lote interrompido por o ISPM fechar fica fechado e legível no arranque', async () => {
    seed(3);
    const router = fakeRouter(3);
    const batchId = createPlanChangeBatch(db, { serviceIds: ids(3), targetPlanId: 2, updatePrice: true, dropMode: 'none' }, router.snapshot(), { dryRun: false, actor: admin });
    db.prepare(`UPDATE plan_change_items SET status = 'applied' WHERE service_id = 1`).run();
    db.prepare(`UPDATE plan_change_items SET status = 'pending' WHERE service_id = 2`).run();

    expect(recoverInterruptedPlanChanges(db)).toBe(1);

    expect(itemStatuses(batchId)).toEqual(['applied', 'applied', 'not_processed']);
    expect(loadPlanChange(db, batchId)).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('fechado a meio') });
  });
});

describe('sessões agendadas', () => {
  const at = (iso: string) => new Date(iso);
  const start = at('2026-10-09T22:00:00Z');
  const read = (router: ReturnType<typeof fakeRouter>) => async () => router.snapshot();

  test('a hora tem de ser futura', () => {
    seed(1);
    const router = fakeRouter(1);
    const create = (dropAt?: string) => () => createPlanChangeBatch(db,
      { serviceIds: [1], targetPlanId: 2, updatePrice: true, dropMode: 'scheduled', dropAt }, router.snapshot(), { dryRun: false, actor: admin, now: start });
    expect(create()).toThrow(/Indique a hora/);
    expect(create('2026-10-09T21:00:00Z')).toThrow(/já passou/);
  });

  test('à hora marcada derruba só as sessões abertas antes da mudança', async () => {
    seed(3);
    const router = fakeRouter(3, { online: [1, 2], uptime: '9h' });
    const { batchId } = await change(router, ids(3), { dropMode: 'scheduled', dropAt: '2026-10-10T04:00:00Z', now: start });
    expect(router.sessions).toHaveLength(2);
    expect(loadPlanChange(db, batchId)).toMatchObject({ dropStatus: 'pending' });

    // Antes da hora não acontece nada.
    expect(await runDueSessionDrops(db, { transport: router.transport, pauseMs: 0, now: () => at('2026-10-10T03:59:00Z') }, read(router)))
      .toMatchObject({ skipped: true });

    // O cliente 2 reconectou sozinho às 03:00: já tem a velocidade nova.
    router.sessions[1].uptime = '1h';
    const result = await runDueSessionDrops(db, { transport: router.transport, pauseMs: 0, now: () => at('2026-10-10T04:00:30Z') }, read(router));

    expect(result).toEqual({ dropped: 1, expired: 0 });
    expect(router.sessions.map((session) => session.name)).toEqual([login(2)]);
    expect(loadPlanChange(db, batchId)).toMatchObject({ dropStatus: 'done' });
    // E não volta a derrubar no tick seguinte.
    expect(await runDueSessionDrops(db, { transport: router.transport, pauseMs: 0, now: () => at('2026-10-10T04:01:30Z') }, read(router)))
      .toMatchObject({ skipped: true });
  });

  test('mais de uma hora atrasado não derruba ninguém', async () => {
    seed(1);
    const router = fakeRouter(1, { online: [1], uptime: '2d' });
    const { batchId } = await change(router, [1], { dropMode: 'scheduled', dropAt: '2026-10-10T04:00:00Z', now: start });

    const result = await runDueSessionDrops(db, { transport: router.transport, pauseMs: 0, now: () => at('2026-10-10T09:30:00Z') }, read(router));

    expect(result).toEqual({ dropped: 0, expired: 1 });
    expect(router.sessions).toHaveLength(1);
    expect(loadPlanChange(db, batchId)).toMatchObject({ dropStatus: 'expired' });
  });

  test('desmarcar as sessões agendadas de um lote já acabado', async () => {
    seed(1);
    const router = fakeRouter(1, { online: [1] });
    const { batchId } = await change(router, [1], { dropMode: 'scheduled', dropAt: '2026-10-10T04:00:00Z', now: start });

    expect(cancelPlanChange(db, batchId)).toBe('drop_cancelled');
    expect(await runDueSessionDrops(db, { transport: router.transport, pauseMs: 0, now: () => at('2026-10-10T04:00:30Z') }, read(router)))
      .toMatchObject({ skipped: true });
    expect(router.sessions).toHaveLength(1);
  });

  test('lê a duração de sessão do RouterOS', () => {
    expect(uptimeSeconds('1w2d3h4m5s')).toBe(604_800 + 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
    expect(uptimeSeconds('45s')).toBe(45);
    expect(uptimeSeconds(null)).toBeNull();
    expect(uptimeSeconds('nunca')).toBeNull();
  });
});

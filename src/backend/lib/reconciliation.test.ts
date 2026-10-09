import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { runNetworkEnforcement } from './network-enforcement';
import { buildReconciliation, resolveReconciliation, type ResolveItem } from './reconciliation';
import { RouterError, type RouterRequest, type RouterSecret, type RouterTransport } from './routeros';
import { writePppoeSecret } from './secrets';

const PROFILES = ['default', 'plano-10M', 'plano-20M', 'SUSPENSO'];
const admin = { user: { id: 7, username: 'ana', fullName: 'Ana', role: 'admin' } } as never;

function secret(overrides: Partial<RouterSecret> = {}): RouterSecret {
  return { id: '*1', name: 'joao-1', disabled: false, profile: 'plano-10M', comment: 'ispm:1 Joao Silva #1', ...overrides };
}

/** Um router em memória: as escritas mudam o que a leitura seguinte devolve. */
function fakeRouter(initial: RouterSecret[], active: Array<{ id: string; name: string }> = []) {
  const secrets = initial.map((item) => ({ ...item }));
  const sessions = [...active];
  const calls: RouterRequest[] = [];
  let down = false;
  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    if (down) throw new RouterError('connect ETIMEDOUT', 0, undefined, 'ETIMEDOUT');
    if (req.path.startsWith('/ppp/profile?')) return PROFILES.map((name, index) => ({ '.id': `*P${index}`, name }));
    if (req.path.startsWith('/ppp/secret?')) {
      return secrets.map((s) => ({ '.id': s.id, name: s.name, disabled: String(s.disabled), profile: s.profile ?? undefined, comment: s.comment ?? undefined }));
    }
    if (req.path.startsWith('/ppp/active?')) return sessions.map((s) => ({ '.id': s.id, name: s.name, address: '10.0.0.9', uptime: '1h' }));
    if (req.method === 'PUT' && req.path === '/ppp/secret') {
      const body = req.body as { name: string; profile?: string; comment?: string };
      secrets.push({ id: '*77', name: body.name, disabled: false, profile: body.profile ?? 'default', comment: body.comment ?? null });
      return { '.id': '*77' };
    }
    if (req.method === 'PATCH' && req.path.startsWith('/ppp/secret/')) {
      const target = secrets.find((s) => s.id === req.path.slice('/ppp/secret/'.length))!;
      const body = req.body as { profile?: string; disabled?: unknown };
      if (body.profile !== undefined) target.profile = body.profile;
      if (body.disabled !== undefined) target.disabled = body.disabled === true || body.disabled === 'yes' || body.disabled === 'true';
      return null;
    }
    if (req.method === 'DELETE' && req.path.startsWith('/ppp/active/')) {
      sessions.splice(sessions.findIndex((s) => s.id === req.path.slice('/ppp/active/'.length)), 1);
      return null;
    }
    return null;
  }) as RouterTransport;
  return {
    transport, calls, secrets, sessions,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    goDown: () => { down = true; },
    read: () => ({
      secrets: secrets.map((s) => ({ ...s })),
      active: sessions.map((s) => ({ ...s, address: null, uptime: null, callerId: null }))
    })
  };
}

let db: Database.Database;

function addService(id: number, status: string, username: string | null, planId = 1) {
  db.prepare(`INSERT INTO clients (id, client_code, full_name, phone) VALUES (?, ?, ?, ?)`)
    .run(id, `CL-${String(id).padStart(4, '0')}`, id === 1 ? 'Joao Silva' : `Cliente ${id}`, `91100${id}`);
  db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (?, ?, ?, 3000, ?, ?)`)
    .run(id, id, planId, status, username);
  if (username) writePppoeSecret(db, id, 'senha');
}

const live = { dryRun: false, maxDisables: 5, pauseMs: 0 };

async function agree(router: ReturnType<typeof fakeRouter>) {
  await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
  router.calls.length = 0;
}

function rows(router: ReturnType<typeof fakeRouter>) {
  const { secrets, active } = router.read();
  return buildReconciliation(db, secrets, active).rows;
}

function resolve(router: ReturnType<typeof fakeRouter>, items: ResolveItem[], deps = live) {
  return resolveReconciliation(db, { transport: router.transport, ...deps }, admin, items, router.read());
}

const serviceRow = (id = 1) => db.prepare('SELECT plan_id AS planId, status, pppoe_username AS username, monthly_value_cve AS value FROM services WHERE id = ?').get(id) as
  { planId: number; status: string; username: string | null; value: number };

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO internet_plans (id, name, router_profile) VALUES (1, 'Base 10', 'plano-10M'), (2, 'Mais 20', 'plano-20M')`).run();
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7, 'ana', 'x', 'admin', 'Ana')`).run();
});

describe('buildReconciliation', () => {
  test('tudo de acordo não mostra nada', async () => {
    addService(1, 'active', 'joao-1');
    expect(rows(fakeRouter([secret()]))).toEqual([]);
  });

  test('deteta o perfil mudado à mão no router e propõe o plano que o usa', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    expect(rows(router)).toEqual([expect.objectContaining({
      key: 'plan:1', kind: 'plan', clientName: 'Joao Silva', held: true,
      ispm: 'Base 10 · plano-10M', router: 'plano-20M', planOptions: [{ id: 2, name: 'Mais 20' }]
    })]);
  });

  test('uma mudança feita no ISPM aparece como pendente, não como retida', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    db.prepare('UPDATE services SET plan_id = 2 WHERE id = 1').run();
    expect(rows(router)).toEqual([expect.objectContaining({ kind: 'plan', held: false })]);
  });

  test('deteta secrets que só existem no router, com e sem a marca do ISPM', () => {
    const router = fakeRouter([
      secret({ id: '*9', name: 'orfao', comment: 'ispm:40 Antigo #40' }),
      secret({ id: '*A', name: 'feito-a-mao', comment: 'torre norte', disabled: true })
    ]);
    expect(rows(router)).toEqual([
      expect.objectContaining({ key: 'only_router:*9', kind: 'only_router', managed: true, login: 'orfao', ispm: 'Não existe' }),
      expect.objectContaining({ key: 'only_router:*A', kind: 'only_router', managed: false, router: 'Desativado · plano-10M' })
    ]);
  });

  test('serviço sem secret é "só no ISPM"; apagado no router fica retido', async () => {
    addService(1, 'active', 'joao-1');
    expect(rows(fakeRouter([]))).toEqual([expect.objectContaining({ key: 'only_ispm:1', held: false, router: 'Não existe' })]);

    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets.length = 0;
    expect(rows(router)).toEqual([expect.objectContaining({ key: 'only_ispm:1', held: true })]);
  });

  test('estado: desativado e perfil de suspensão contam os dois como sem serviço', async () => {
    addService(1, 'suspended', 'joao-1');
    // Suspenso no ISPM, cortado no router por `disabled`: o mecanismo difere, o acesso não.
    expect(rows(fakeRouter([secret({ disabled: true })])).filter((row) => row.kind === 'state')).toEqual([]);
    expect(rows(fakeRouter([secret()]))).toEqual([
      expect.objectContaining({ key: 'state:1', kind: 'state', ispm: 'Suspenso', router: 'Com serviço (plano-10M)' })
    ]);
  });

  test('lista os serviços sem utilizador PPPoE para associar', () => {
    addService(1, 'active', null);
    const { secrets, active } = fakeRouter([]).read();
    expect(buildReconciliation(db, secrets, active).unlinkedServices).toEqual([{ serviceId: 1, clientName: 'Joao Silva', clientCode: 'CL-0001' }]);
  });
});

describe('resolveReconciliation', () => {
  test('plano → router: repõe o perfil do ISPM e deixa auditoria com quem decidiu', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    const results = await resolve(router, [{ key: 'plan:1', direction: 'ispm' }]);

    expect(results).toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(router.writes()).toEqual([{ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'plano-10M' } }]);
    expect(rows(router)).toEqual([]);
    expect(db.prepare(`SELECT actor_username AS actor, entity_id AS entity FROM audit_logs WHERE action = 'reconciliation_apply'`).get())
      .toEqual({ actor: 'ana', entity: '1' });
  });

  test('plano → ISPM: o serviço passa ao plano do perfil, sem tocar no router nem na mensalidade', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    const results = await resolve(router, [{ key: 'plan:1', direction: 'router' }]);

    expect(results[0].status).toBe('applied');
    expect(router.writes()).toEqual([]);
    expect(serviceRow()).toMatchObject({ planId: 2, value: 3000, status: 'active' });
    expect(rows(router)).toEqual([]);
    const audit = db.prepare(`SELECT metadata_json AS meta FROM audit_logs WHERE action = 'reconciliation_import'`).get() as { meta: string };
    expect(JSON.parse(audit.meta)).toMatchObject({ fromPlanId: 1, toPlanId: 2, direction: 'router' });

    // E a passagem seguinte não desfaz o que acabou de ser decidido.
    await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
    expect(router.writes()).toEqual([]);
  });

  test('importar plano ambíguo pede escolha; sem plano nenhum, recusa', async () => {
    addService(1, 'active', 'joao-1');
    db.prepare(`INSERT INTO internet_plans (id, name, router_profile) VALUES (3, 'Empresas 20', 'plano-20M')`).run();
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    expect((await resolve(router, [{ key: 'plan:1', direction: 'router' }]))[0])
      .toMatchObject({ status: 'failed', message: expect.stringContaining('escolha qual') });
    expect(serviceRow().planId).toBe(1);
    expect((await resolve(router, [{ key: 'plan:1', direction: 'router', planId: 3 }]))[0].status).toBe('applied');
    expect(serviceRow().planId).toBe(3);

    router.secrets[0].profile = 'default';
    expect((await resolve(router, [{ key: 'plan:3', direction: 'router' }]))[0].status).toBe('failed');
    expect((await resolve(router, [{ key: 'plan:1', direction: 'router' }]))[0])
      .toMatchObject({ status: 'failed', message: expect.stringContaining('Nenhum plano') });
  });

  test('importar o plano de um suspenso não existe: a diferença dele é de estado', async () => {
    addService(1, 'suspended', 'joao-1');
    const router = fakeRouter([secret({ profile: 'SUSPENSO' })]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    expect(rows(router).map((row) => row.key)).toEqual(['state:1']);
    expect((await resolve(router, [{ key: 'plan:1', direction: 'router' }]))[0].status).toBe('failed');
    expect(serviceRow().status).toBe('suspended');
  });

  test('estado → ISPM: desativado no router suspende o serviço, com evento na cronologia', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].disabled = true;

    expect((await resolve(router, [{ key: 'state:1', direction: 'router' }]))[0].status).toBe('applied');
    expect(serviceRow().status).toBe('suspended');
    expect(router.writes()).toEqual([]);
    expect(db.prepare(`SELECT event_type AS type, notes FROM service_events WHERE service_id = 1`).get())
      .toEqual({ type: 'suspensao', notes: 'Importado do router na reconciliação' });
    expect(rows(router)).toEqual([]);
    await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
    expect(router.writes()).toEqual([]);
  });

  test('estado → router: suspenso reposto à mão volta a ser cortado, com a sessão derrubada', async () => {
    addService(1, 'suspended', 'joao-1');
    const router = fakeRouter([secret({ profile: 'SUSPENSO' })], [{ id: '*S', name: 'joao-1' }]);
    await agree(router);
    router.secrets[0].profile = 'plano-10M';

    expect((await resolve(router, [{ key: 'state:1', direction: 'ispm' }]))[0].status).toBe('applied');
    expect(router.secrets[0].profile).toBe('SUSPENSO');
    expect(router.sessions).toEqual([]);
  });

  test('só no ISPM: recriar no router, ou tirar o utilizador do serviço', async () => {
    addService(1, 'active', 'joao-1');
    addService(2, 'active', 'ana-2');
    const router = fakeRouter([secret(), secret({ id: '*2', name: 'ana-2', comment: 'ispm:2 Cliente 2 #2' })]);
    await agree(router);
    router.secrets.length = 0;

    const results = await resolve(router, [
      { key: 'only_ispm:1', direction: 'ispm' },
      { key: 'only_ispm:2', direction: 'router' }
    ]);

    expect(results.map((item) => item.status)).toEqual(['applied', 'applied']);
    expect(router.secrets.map((item) => item.name)).toEqual(['joao-1']);
    expect(serviceRow(2).username).toBeNull();
    expect(rows(router)).toEqual([]);
  });

  test('só no router: associa a um serviço sem utilizador e não lhe mexe a seguir', async () => {
    addService(1, 'active', null);
    const router = fakeRouter([secret({ name: 'casa-da-esquina', comment: 'feito a mao', profile: 'plano-20M' })]);

    expect((await resolve(router, [{ key: 'only_router:*1', direction: 'router' }]))[0])
      .toMatchObject({ status: 'failed', message: expect.stringContaining('Escolha o serviço') });
    expect((await resolve(router, [{ key: 'only_router:*1', direction: 'router', targetServiceId: 1 }]))[0].status).toBe('applied');
    expect(serviceRow().username).toBe('casa-da-esquina');

    // O perfil que tinha no router continua lá: passa a ser uma diferença de plano, retida.
    await runNetworkEnforcement(db, { transport: router.transport, dryRun: false, maxDisables: 5 });
    expect(router.writes()).toEqual([]);
    expect(rows(router)).toEqual([expect.objectContaining({ key: 'plan:1', held: true })]);
  });

  test('só no router: desativa e nunca apaga; o feito à mão exige o nome escrito', async () => {
    const router = fakeRouter(
      [secret({ id: '*9', name: 'orfao', comment: 'ispm:40 Antigo #40' }), secret({ id: '*A', name: 'feito-a-mao', comment: null })],
      [{ id: '*S', name: 'orfao' }]
    );

    const results = await resolve(router, [
      { key: 'only_router:*9', direction: 'ispm' },
      { key: 'only_router:*A', direction: 'ispm' },
      { key: 'only_router:*A', direction: 'ispm', confirmName: 'feito-a-mao' }
    ]);

    expect(results.map((item) => item.status)).toEqual(['applied', 'failed', 'applied']);
    expect(router.secrets.map((item) => [item.name, item.disabled])).toEqual([['orfao', true], ['feito-a-mao', true]]);
    expect(router.sessions).toEqual([]);
    expect(router.calls.some((call) => call.method === 'DELETE' && call.path.startsWith('/ppp/secret'))).toBe(false);
  });

  test('em ensaio diz o que faria e não escreve em lado nenhum', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';

    const results = await resolve(router, [
      { key: 'plan:1', direction: 'ispm' },
      { key: 'plan:1', direction: 'router' }
    ], { ...live, dryRun: true });

    expect(results.map((item) => item.status)).toEqual(['dry_run', 'dry_run']);
    expect(router.writes()).toEqual([]);
    expect(serviceRow().planId).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'reconciliation%'`).get()).toEqual({ n: 0 });
  });

  test('router inacessível a meio: pára e diz o que ficou por processar', async () => {
    addService(1, 'active', 'joao-1');
    addService(2, 'active', 'ana-2');
    const router = fakeRouter([secret(), secret({ id: '*2', name: 'ana-2', comment: 'ispm:2 Cliente 2 #2' })]);
    await agree(router);
    router.secrets[0].profile = 'plano-20M';
    router.secrets[1].profile = 'plano-20M';
    const snapshot = router.read();
    router.goDown();

    const results = await resolveReconciliation(db, { transport: router.transport, ...live }, admin, [
      { key: 'plan:1', direction: 'ispm' },
      { key: 'plan:2', direction: 'ispm' }
    ], snapshot);

    expect(results.map((item) => item.status)).toEqual(['failed', 'not_processed']);
    expect(router.writes()).toEqual([]);
  });

  test('uma divergência que já não existe é recusada, não adivinhada', async () => {
    addService(1, 'active', 'joao-1');
    const router = fakeRouter([secret()]);
    expect((await resolve(router, [{ key: 'plan:1', direction: 'ispm' }]))[0])
      .toMatchObject({ status: 'failed', message: expect.stringContaining('já não existe') });
  });
});

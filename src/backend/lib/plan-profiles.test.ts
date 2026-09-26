import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { applyPlanProfile, planProfileAction, rateLimitFor, syncPlanProfiles, type PlanForProfile } from './plan-profiles';
import type { RouterProfile, RouterRequest, RouterTransport } from './routeros';

function profile(overrides: Partial<RouterProfile> = {}): RouterProfile {
  return {
    id: '*0',
    name: 'default',
    rateLimit: null,
    localAddress: '10.10.0.1',
    remoteAddress: 'pool-clientes',
    dnsServer: '1.1.1.1',
    onlyOne: 'yes',
    comment: null,
    ...overrides
  };
}

const plan: PlanForProfile = { id: 1, name: 'Standart', uploadMbps: 20, downloadMbps: 20, routerProfile: 'plano-20M' };

describe('rateLimitFor', () => {
  test('rx/tx do lado do router: upload primeiro; sem os dois números não há limite', () => {
    expect(rateLimitFor(2, 10)).toBe('2M/10M');
    expect(rateLimitFor(null, 10)).toBeNull();
    expect(rateLimitFor(0, 10)).toBeNull();
  });
});

describe('planProfileAction', () => {
  test('perfil em falta: cria-o a partir do perfil-base', () => {
    const action = planProfileAction(plan, [profile()], 'default');
    expect(action).toMatchObject({ kind: 'create', name: 'plano-20M', rateLimit: '20M/20M', comment: 'ispm:plano:1' });
    expect(action.kind === 'create' && action.base.name).toBe('default');
  });

  test('sem Mbps, sem nome ou sem perfil-base não se cria nada — e diz-se porquê', () => {
    expect(planProfileAction({ ...plan, uploadMbps: null }, [profile()], 'default'))
      .toMatchObject({ kind: 'none', detail: expect.stringContaining('Mbps') });
    expect(planProfileAction({ ...plan, routerProfile: null }, [profile()], 'default'))
      .toMatchObject({ kind: 'none', detail: expect.stringContaining('nome') });
    expect(planProfileAction(plan, [profile()], 'nao-existe'))
      .toMatchObject({ kind: 'none', detail: expect.stringContaining('nao-existe') });
  });

  test('perfil nosso com outro limite: atualiza só o limite', () => {
    const ours = profile({ id: '*A', name: 'plano-20M', rateLimit: '10M/10M', comment: 'ispm:plano:1' });
    expect(planProfileAction(plan, [profile(), ours], 'default'))
      .toEqual({ kind: 'update', id: '*A', name: 'plano-20M', rateLimit: '20M/20M', previous: '10M/10M' });
  });

  test('perfil nosso já certo: nada a fazer', () => {
    const ours = profile({ id: '*A', name: 'plano-20M', rateLimit: '20M/20M', comment: 'ispm:plano:1' });
    expect(planProfileAction(plan, [ours], 'default')).toMatchObject({ kind: 'none', owned: true });
  });

  // O perfil feito no Winbox é do operador: escolhê-lo no plano não dá ao ISPM
  // licença para lhe mexer. Nem o de outro plano.
  test('perfil do operador ou de outro plano nunca é alterado', () => {
    const operator = profile({ id: '*B', name: 'plano-20M', rateLimit: '5M/5M' });
    expect(planProfileAction(plan, [operator], 'default')).toMatchObject({ kind: 'none', owned: false });
    const otherPlan = profile({ id: '*C', name: 'plano-20M', rateLimit: '5M/5M', comment: 'ispm:plano:9' });
    expect(planProfileAction(plan, [otherPlan], 'default')).toMatchObject({ kind: 'none', owned: false });
  });
});

describe('applyPlanProfile', () => {
  function dbWithPlan() {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
      VALUES (1, 'Standart', '20 Mb/s', '20 Mb/s', 20, 20, 'plano-20M')
    `).run();
    return db;
  }

  function recording(profiles: RouterProfile[]) {
    const calls: RouterRequest[] = [];
    const transport = (async (req: RouterRequest) => {
      calls.push(req);
      if (req.method === 'GET') {
        return profiles.map((p) => ({ '.id': p.id, name: p.name, 'rate-limit': p.rateLimit ?? undefined, 'local-address': p.localAddress ?? undefined, comment: p.comment ?? undefined }));
      }
      return { '.id': '*NEW' };
    }) as RouterTransport;
    return { transport, calls };
  }

  test('em ensaio diz o que faria e não escreve no router', async () => {
    const { transport, calls } = recording([profile()]);
    const result = await applyPlanProfile(dbWithPlan(), { transport, dryRun: true }, 1);
    expect(result).toMatchObject({ dryRun: true, applied: false, action: { kind: 'create' } });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('em efetivo cria o perfil', async () => {
    const { transport, calls } = recording([profile()]);
    const result = await applyPlanProfile(dbWithPlan(), { transport, dryRun: false }, 1);
    expect(result).toMatchObject({ dryRun: false, applied: true, action: { kind: 'create' } });
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/ppp/profile', body: { name: 'plano-20M', 'rate-limit': '20M/20M' } });
  });

  test('plano inexistente devolve null', async () => {
    const { transport } = recording([]);
    expect(await applyPlanProfile(dbWithPlan(), { transport, dryRun: false }, 99)).toBeNull();
  });
});

describe('syncPlanProfiles', () => {
  function dbWithPlans() {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
      VALUES (1, 'Standart', '20 Mb/s', '20 Mb/s', 20, 20, 'ispm-plano-1'),
             (2, 'Operador', '40 Mb/s', '20 Mb/s', 40, 20, 'PLANO-40-20'),
             (3, 'Sem Mbps', 'rapido', 'rapido', NULL, NULL, 'ispm-plano-3'),
             (4, 'Sem perfil', '5 Mb/s', '5 Mb/s', 5, 5, NULL)
    `).run();
    return db;
  }

  function stateful(initial: RouterProfile[], failPut = false) {
    const profiles = [...initial];
    const calls: RouterRequest[] = [];
    const transport = (async (req: RouterRequest) => {
      calls.push(req);
      if (req.method === 'GET') {
        return profiles.map((p) => ({ '.id': p.id, name: p.name, 'rate-limit': p.rateLimit ?? undefined, 'local-address': p.localAddress ?? undefined, comment: p.comment ?? undefined }));
      }
      if (req.method === 'PUT') {
        if (failPut) throw new Error('router ocupado');
        const body = req.body as Record<string, string>;
        profiles.push(profile({ id: `*N${profiles.length}`, name: body.name, rateLimit: body['rate-limit'], comment: body.comment }));
        return { '.id': `*N${profiles.length}` };
      }
      return null;
    }) as RouterTransport;
    return { transport, calls, profiles };
  }

  const operatorProfile = profile({ id: '*OP', name: 'PLANO-40-20', rateLimit: '20M/40M 20M/60M', comment: null });
  const stateOf = (db: Database.Database, planId: number) =>
    db.prepare('SELECT status, detail, last_error AS lastError FROM plan_router_sync WHERE plan_id = ?').get(planId) as
      | { status: string; detail: string | null; lastError: string | null }
      | undefined;

  test('cria os perfis em falta, preserva o do operador e deixa pendente o plano sem Mbps', async () => {
    const db = dbWithPlans();
    const { transport, calls } = stateful([profile(), operatorProfile]);

    const summary = await syncPlanProfiles(db, { transport, dryRun: false });

    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ path: '/ppp/profile', body: { name: 'ispm-plano-1', 'rate-limit': '20M/20M', comment: 'ispm:plano:1' } });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(summary).toMatchObject({ plans: 3, applied: 1, failed: 0 });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
    expect(stateOf(db, 2)).toMatchObject({ status: 'external' });
    expect(stateOf(db, 3)).toMatchObject({ status: 'pending', detail: expect.stringContaining('Mbps') });
    // Plano sem nome de perfil não entra na sincronização.
    expect(stateOf(db, 4)).toBeUndefined();
    const audit = db.prepare(`SELECT actor_username AS actor, entity_type AS type, entity_id AS id FROM audit_logs`).get();
    expect(audit).toEqual({ actor: 'sistema', type: 'plan', id: '1' });
  });

  test('é idempotente: a segunda passagem não escreve nada', async () => {
    const db = dbWithPlans();
    const router = stateful([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: router.transport, dryRun: false });
    const writesBefore = router.calls.filter((call) => call.method !== 'GET').length;

    const summary = await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.calls.filter((call) => call.method !== 'GET').length).toBe(writesBefore);
    expect(summary.applied).toBe(0);
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced' });
  });

  test('mudar os Mbps de um plano atualiza só o limite do perfil próprio', async () => {
    const db = dbWithPlans();
    const ours = profile({ id: '*A', name: 'ispm-plano-1', rateLimit: '10M/10M', comment: 'ispm:plano:1' });
    const { transport, calls } = stateful([profile(), operatorProfile, ours]);

    await syncPlanProfiles(db, { transport, dryRun: false });

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/ppp/profile/*A', body: { 'rate-limit': '20M/20M' } }
    ]);
  });

  test('falha do router fica no plano e a passagem seguinte volta a tentar', async () => {
    const db = dbWithPlans();
    const failing = stateful([profile(), operatorProfile], true);
    const failed = await syncPlanProfiles(db, { transport: failing.transport, dryRun: false });
    expect(failed.failed).toBe(1);
    expect(stateOf(db, 1)).toMatchObject({ status: 'error', lastError: 'router ocupado' });

    const healthy = stateful([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: healthy.transport, dryRun: false });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
  });

  test('falha ao ler perfis regista o erro em cada plano e permite nova tentativa', async () => {
    const db = dbWithPlans();
    const offline = (async () => { throw new Error('router indisponível'); }) as RouterTransport;
    const failed = await syncPlanProfiles(db, { transport: offline, dryRun: false });
    expect(failed.failed).toBe(3);
    expect(stateOf(db, 1)).toMatchObject({ status: 'error', lastError: 'router indisponível' });
    expect(stateOf(db, 2)).toMatchObject({ status: 'error', lastError: 'router indisponível' });
    const healthy = stateful([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: healthy.transport, dryRun: false });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
  });

  test('em ensaio regista a ação prevista sem escrever no router', async () => {
    const db = dbWithPlans();
    const { transport, calls } = stateful([profile(), operatorProfile]);

    await syncPlanProfiles(db, { transport, dryRun: true });

    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(stateOf(db, 1)).toMatchObject({ status: 'dry_run', detail: expect.stringContaining('ispm-plano-1') });
  });

  test('um plano gravado em ensaio é criado na primeira passagem efetiva', async () => {
    const db = dbWithPlans();
    const router = stateful([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: router.transport, dryRun: true });
    expect(router.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);

    await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
  });
});

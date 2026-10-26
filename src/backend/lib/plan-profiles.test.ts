import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  applyPlanProfile, networkFields, planProfileAction, rateLimitFor, readPlanNetwork, syncPlanProfiles,
  type PlanForProfile, type PlanNetwork
} from './plan-profiles';
import type { RouterProfile, RouterRequest, RouterTransport } from './routeros';

function profile(overrides: Partial<RouterProfile> = {}): RouterProfile {
  return {
    id: '*0',
    name: 'default',
    rateLimit: null,
    localAddress: null,
    remoteAddress: null,
    dnsServer: null,
    onlyOne: null,
    interfaceList: null,
    parentQueue: null,
    comment: null,
    ...overrides
  };
}

const network: PlanNetwork = {
  localAddress: '10.20.0.1',
  remotePool: 'pool-PPPOE',
  interfaceList: 'PPPOE',
  dnsServer: '10.20.0.1',
  parentQueue: 'TOTAL-SKYNET'
};

/** O perfil tal como o ISPM o deixa: tudo o que as Definições pedem. */
const complete = (overrides: Partial<RouterProfile> = {}) => profile({
  id: '*A', name: 'plano-20M', rateLimit: '20M/20M', comment: 'ispm:plano:1',
  localAddress: '10.20.0.1', remoteAddress: 'pool-PPPOE', dnsServer: '10.20.0.1', onlyOne: 'yes',
  interfaceList: 'PPPOE', parentQueue: 'TOTAL-SKYNET', ...overrides
});

const plan: PlanForProfile = { id: 1, name: 'Standart', uploadMbps: 20, downloadMbps: 20, routerProfile: 'plano-20M' };

describe('rateLimitFor', () => {
  test('rx/tx do lado do router: upload primeiro; sem os dois números não há limite', () => {
    expect(rateLimitFor(2, 10)).toBe('2M/10M');
    expect(rateLimitFor(null, 10)).toBeNull();
    expect(rateLimitFor(0, 10)).toBeNull();
  });
});

describe('networkFields', () => {
  test('com tudo preenchido dá os campos de rede e only-one=yes', () => {
    expect(networkFields(network)).toEqual({
      fields: {
        'local-address': '10.20.0.1', 'remote-address': 'pool-PPPOE', 'interface-list': 'PPPOE',
        'dns-server': '10.20.0.1', 'parent-queue': 'TOTAL-SKYNET', 'only-one': 'yes'
      }
    });
  });

  test('diz em pt-PT o que falta', () => {
    expect(networkFields({ ...network, localAddress: '', parentQueue: '' })).toEqual({ missing: ['gateway PPPoE', 'fila-mãe'] });
  });
});

describe('readPlanNetwork', () => {
  test('DNS em branco é o gateway; lista em branco é PPPOE; nada vem do código além disso', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(readPlanNetwork(db)).toEqual({ localAddress: '', remotePool: '', interfaceList: 'PPPOE', dnsServer: '', parentQueue: '' });
    const set = db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    set.run('routerosPppLocalAddress', '10.20.0.1');
    set.run('routerosPppInterfaceList', 'CLIENTES');
    expect(readPlanNetwork(db)).toMatchObject({ localAddress: '10.20.0.1', dnsServer: '10.20.0.1', interfaceList: 'CLIENTES' });
  });
});

describe('planProfileAction', () => {
  test('perfil em falta: cria-o com todos os campos obrigatórios', () => {
    expect(planProfileAction(plan, [profile()], network)).toEqual({
      kind: 'create',
      name: 'plano-20M',
      fields: {
        name: 'plano-20M', comment: 'ispm:plano:1', 'rate-limit': '20M/20M',
        'local-address': '10.20.0.1', 'remote-address': 'pool-PPPOE', 'interface-list': 'PPPOE',
        'dns-server': '10.20.0.1', 'parent-queue': 'TOTAL-SKYNET', 'only-one': 'yes'
      }
    });
  });

  // O caso de 2026-10-09: o perfil saiu só com nome e limite e 24 clientes ficavam sem IP.
  test('faltando um campo nas Definições não cria nada e diz qual', () => {
    const action = planProfileAction(plan, [profile()], { ...network, remotePool: '' });
    expect(action).toMatchObject({ kind: 'none', detail: expect.stringContaining('pool de endereços') });
    expect(action).not.toHaveProperty('owned');
  });

  test('sem Mbps ou sem nome não se cria nada — e diz-se porquê', () => {
    expect(planProfileAction({ ...plan, uploadMbps: null }, [profile()], network))
      .toMatchObject({ kind: 'none', detail: expect.stringContaining('Mbps') });
    expect(planProfileAction({ ...plan, routerProfile: null }, [profile()], network))
      .toMatchObject({ kind: 'none', detail: expect.stringContaining('nome') });
  });

  test('perfil nosso incompleto: corrige só os campos em falta, com o antes e o depois', () => {
    const bare = profile({ id: '*A', name: 'plano-20M', rateLimit: '20M/20M', comment: 'ispm:plano:1' });
    const action = planProfileAction(plan, [bare], network);
    expect(action).toMatchObject({ kind: 'update', id: '*A', name: 'plano-20M' });
    if (action.kind !== 'update') throw new Error('esperava update');
    expect(action.diff.after).toEqual({
      'local-address': '10.20.0.1', 'remote-address': 'pool-PPPOE', 'interface-list': 'PPPOE',
      'dns-server': '10.20.0.1', 'parent-queue': 'TOTAL-SKYNET', 'only-one': 'yes'
    });
    expect(action.diff.before['local-address']).toBe('');
    // O limite já estava certo: não se lhe toca.
    expect(action.diff.after).not.toHaveProperty('rate-limit');
  });

  test('perfil nosso com outros Mbps: atualiza só o limite', () => {
    const action = planProfileAction(plan, [complete({ rateLimit: '10M/10M' })], network);
    expect(action).toEqual({
      kind: 'update', id: '*A', name: 'plano-20M',
      diff: { before: { 'rate-limit': '10M/10M' }, after: { 'rate-limit': '20M/20M' } }
    });
  });

  test('o burst posto à mão no router fica', () => {
    const burst = complete({ rateLimit: '20M/20M 30M/40M 20M/20M 15/15 5 2M/4M' });
    expect(planProfileAction(plan, [burst], network)).toMatchObject({ kind: 'none', owned: true });
  });

  test('perfil nosso completo: nada a fazer', () => {
    expect(planProfileAction(plan, [complete()], network)).toMatchObject({ kind: 'none', owned: true });
  });

  // O perfil feito no Winbox é do operador: escolhê-lo no plano não dá ao ISPM
  // licença para lhe mexer. Nem o de outro plano — mesmo incompleto.
  test('perfil do operador ou de outro plano nunca é alterado', () => {
    const operator = profile({ id: '*B', name: 'plano-20M', rateLimit: '5M/5M' });
    expect(planProfileAction(plan, [operator], network)).toMatchObject({ kind: 'none', owned: false });
    const otherPlan = profile({ id: '*C', name: 'plano-20M', rateLimit: '5M/5M', comment: 'ispm:plano:9' });
    expect(planProfileAction(plan, [otherPlan], network)).toMatchObject({ kind: 'none', owned: false });
  });
});

const NETWORK_SETTINGS: Array<[string, string]> = [
  ['routerosPppLocalAddress', '10.20.0.1'],
  ['routerosPppRemotePool', 'pool-PPPOE'],
  ['routerosPppParentQueue', 'TOTAL-SKYNET']
];

function withNetwork(db: Database.Database) {
  const set = db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  for (const [key, value] of NETWORK_SETTINGS) set.run(key, value);
  return db;
}

const REST_FIELDS: Record<string, keyof RouterProfile> = {
  name: 'name', comment: 'comment', 'rate-limit': 'rateLimit', 'local-address': 'localAddress',
  'remote-address': 'remoteAddress', 'dns-server': 'dnsServer', 'only-one': 'onlyOne',
  'interface-list': 'interfaceList', 'parent-queue': 'parentQueue'
};

/** Um router de mentira que guarda os perfis em memória e responde à REST como o RouterOS. */
function fakeRouter(initial: RouterProfile[], failPut = false) {
  const profiles = initial.map((p) => ({ ...p }));
  const calls: RouterRequest[] = [];
  const toRest = (p: RouterProfile) => Object.fromEntries([
    ['.id', p.id],
    ...Object.entries(REST_FIELDS).map(([rest, key]) => [rest, p[key] ?? undefined])
  ]);
  const apply = (target: RouterProfile, body: Record<string, string>) => {
    for (const [rest, value] of Object.entries(body)) Object.assign(target, { [REST_FIELDS[rest]]: value });
  };
  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    if (req.method === 'GET') return profiles.map(toRest);
    if (req.method === 'PUT') {
      if (failPut) throw new Error('router ocupado');
      const created = profile({ id: `*N${profiles.length}` });
      apply(created, req.body as Record<string, string>);
      profiles.push(created);
      return { '.id': created.id };
    }
    if (req.method === 'PATCH') {
      const target = profiles.find((p) => req.path === `/ppp/profile/${p.id}`);
      if (!target) throw new Error(`sem perfil em ${req.path}`);
      apply(target, req.body as Record<string, string>);
      return null;
    }
    throw new Error(`${req.method} não esperado`);
  }) as RouterTransport;
  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { transport, calls, profiles, writes };
}

describe('applyPlanProfile', () => {
  function dbWithPlan() {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
      VALUES (1, 'Standart', '20 Mb/s', '20 Mb/s', 20, 20, 'plano-20M')
    `).run();
    return withNetwork(db);
  }

  test('em ensaio diz o que faria e não escreve no router', async () => {
    const router = fakeRouter([profile()]);
    const result = await applyPlanProfile(dbWithPlan(), { transport: router.transport, dryRun: true }, 1);
    expect(result).toMatchObject({ dryRun: true, applied: false, action: { kind: 'create' }, summary: 'Criaria o perfil plano-20M com 20M/20M' });
    expect(router.writes()).toHaveLength(0);
  });

  test('em efetivo cria o perfil completo', async () => {
    const router = fakeRouter([profile()]);
    const result = await applyPlanProfile(dbWithPlan(), { transport: router.transport, dryRun: false }, 1);
    expect(result).toMatchObject({ dryRun: false, applied: true, action: { kind: 'create' } });
    expect(router.profiles.at(-1)).toMatchObject({ name: 'plano-20M', localAddress: '10.20.0.1', interfaceList: 'PPPOE', parentQueue: 'TOTAL-SKYNET', onlyOne: 'yes' });
  });

  test('plano inexistente devolve null', async () => {
    expect(await applyPlanProfile(dbWithPlan(), { transport: fakeRouter([]).transport, dryRun: false }, 99)).toBeNull();
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
    return withNetwork(db);
  }

  const operatorProfile = profile({ id: '*OP', name: 'PLANO-40-20', rateLimit: '20M/40M 20M/60M' });
  const stateOf = (db: Database.Database, planId: number) =>
    db.prepare('SELECT status, detail, last_error AS lastError FROM plan_router_sync WHERE plan_id = ?').get(planId) as
      | { status: string; detail: string | null; lastError: string | null }
      | undefined;

  test('cria os perfis em falta, preserva o do operador e deixa pendente o plano sem Mbps', async () => {
    const db = dbWithPlans();
    const router = fakeRouter([profile(), operatorProfile]);

    const summary = await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.writes()).toHaveLength(1);
    expect(router.writes()[0]).toMatchObject({ method: 'PUT', path: '/ppp/profile', body: { name: 'ispm-plano-1', 'rate-limit': '20M/20M', comment: 'ispm:plano:1' } });
    expect(summary).toMatchObject({ plans: 3, applied: 1, failed: 0 });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
    expect(stateOf(db, 2)).toMatchObject({ status: 'external' });
    expect(stateOf(db, 3)).toMatchObject({ status: 'pending', detail: expect.stringContaining('Mbps') });
    expect(stateOf(db, 4)).toBeUndefined();
    expect(router.profiles.find((p) => p.id === '*OP')).toEqual(operatorProfile);
  });

  // Integração pedida: criar, sincronizar duas vezes — um só perfil, sem campos perdidos, sem 2.º PATCH.
  test('duas passagens: um só perfil completo e a segunda não escreve nada', async () => {
    const db = dbWithPlans();
    const router = fakeRouter([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: router.transport, dryRun: false });
    const writesAfterFirst = router.writes().length;

    const second = await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.writes()).toHaveLength(writesAfterFirst);
    expect(second.applied).toBe(0);
    const ours = router.profiles.filter((p) => p.name === 'ispm-plano-1');
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      comment: 'ispm:plano:1', rateLimit: '20M/20M', localAddress: '10.20.0.1', remoteAddress: 'pool-PPPOE',
      dnsServer: '10.20.0.1', interfaceList: 'PPPOE', parentQueue: 'TOTAL-SKYNET', onlyOne: 'yes'
    });
    expect(router.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('perfil nosso incompleto é corrigido por PATCH no mesmo .id e a auditoria guarda o antes e o depois', async () => {
    const db = dbWithPlans();
    const bare = profile({ id: '*A', name: 'ispm-plano-1', rateLimit: '20M/20M', comment: 'ispm:plano:1' });
    const router = fakeRouter([profile(), operatorProfile, bare]);

    await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: '/ppp/profile/*A' })]);
    expect(router.writes()[0].body).not.toHaveProperty('rate-limit');
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', detail: expect.stringContaining('Corrigiu o perfil ispm-plano-1') });
    const audit = db.prepare("SELECT action, metadata_json AS meta FROM audit_logs WHERE entity_type = 'plan'").get() as { action: string; meta: string };
    expect(audit.action).toBe('router_profile_update');
    expect(JSON.parse(audit.meta)).toMatchObject({
      profile: 'ispm-plano-1',
      before: { 'local-address': '', 'parent-queue': '' },
      after: { 'local-address': '10.20.0.1', 'parent-queue': 'TOTAL-SKYNET' }
    });
  });

  test('Definições incompletas: nenhum perfil criado, plano pendente com a razão', async () => {
    const db = dbWithPlans();
    db.prepare("DELETE FROM app_settings WHERE key = 'routerosPppParentQueue'").run();
    const router = fakeRouter([profile(), operatorProfile]);

    await syncPlanProfiles(db, { transport: router.transport, dryRun: false });

    expect(router.writes()).toHaveLength(0);
    expect(stateOf(db, 1)).toMatchObject({ status: 'pending', detail: expect.stringContaining('fila-mãe') });
  });

  test('falha do router fica no plano e a passagem seguinte volta a tentar', async () => {
    const db = dbWithPlans();
    const failed = await syncPlanProfiles(db, { transport: fakeRouter([profile(), operatorProfile], true).transport, dryRun: false });
    expect(failed.failed).toBe(1);
    expect(stateOf(db, 1)).toMatchObject({ status: 'error', lastError: 'router ocupado' });

    await syncPlanProfiles(db, { transport: fakeRouter([profile(), operatorProfile]).transport, dryRun: false });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
  });

  test('falha ao ler perfis regista o erro em cada plano e permite nova tentativa', async () => {
    const db = dbWithPlans();
    const offline = (async () => { throw new Error('router indisponível'); }) as RouterTransport;
    const failed = await syncPlanProfiles(db, { transport: offline, dryRun: false });
    expect(failed.failed).toBe(3);
    expect(stateOf(db, 2)).toMatchObject({ status: 'error', lastError: 'router indisponível' });
    await syncPlanProfiles(db, { transport: fakeRouter([profile(), operatorProfile]).transport, dryRun: false });
    expect(stateOf(db, 1)).toMatchObject({ status: 'synced', lastError: null });
  });

  test('em ensaio regista a ação prevista sem escrever no router', async () => {
    const db = dbWithPlans();
    const router = fakeRouter([profile(), operatorProfile]);
    await syncPlanProfiles(db, { transport: router.transport, dryRun: true });
    expect(router.writes()).toHaveLength(0);
    expect(stateOf(db, 1)).toMatchObject({ status: 'dry_run', detail: expect.stringContaining('ispm-plano-1') });
  });
});

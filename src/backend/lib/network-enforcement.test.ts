import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  loadDesiredServices,
  planActions,
  runNetworkEnforcement,
  type DesiredService
} from './network-enforcement';
import type { RouterRequest, RouterSecret, RouterTransport } from './routeros';

function service(overrides: Partial<DesiredService> = {}): DesiredService {
  return {
    serviceId: 1,
    clientName: 'Joao Silva',
    username: 'joao-1',
    password: 'segredo',
    passwordPending: false,
    enabled: true,
    profile: 'plano-10M',
    ...overrides
  };
}

function secret(overrides: Partial<RouterSecret> = {}): RouterSecret {
  return {
    id: '*1',
    name: 'joao-1',
    disabled: false,
    profile: 'plano-10M',
    comment: 'ispm:1',
    ...overrides
  };
}

describe('planActions', () => {
  test('serviço ativo e coerente com o router não gera ação nenhuma', () => {
    const plan = planActions([service()], [secret()]);
    expect(plan.actions).toEqual([]);
    expect(plan.divergences).toEqual([]);
  });

  test('serviço sem secret no router pede aprovisionamento', () => {
    const plan = planActions([service()], []);
    expect(plan.actions).toEqual([
      { kind: 'create', serviceId: 1, username: 'joao-1', profile: 'plano-10M', clientName: 'Joao Silva' }
    ]);
    expect(plan.divergences[0].kind).toBe('missing_secret');
  });

  test('serviço cancelado ainda ativo no router pede corte', () => {
    const plan = planActions([service({ enabled: false })], [secret()]);
    expect(plan.actions).toEqual([
      { kind: 'disable', serviceId: 1, username: 'joao-1', secretId: '*1', clientName: 'Joao Silva', cut: true }
    ]);
  });

  test('suspenso ativo muda para SUSPENSO com corte e sem desativar', () => {
    const plan = planActions([service({ suspended: true, profile: 'SUSPENSO' })], [secret()],
      { suspendedProfile: 'SUSPENSO', baseProfile: 'default' });
    expect(plan.actions).toEqual([
      { kind: 'profile', serviceId: 1, username: 'joao-1', secretId: '*1', profile: 'SUSPENSO', from: 'plano-10M', clientName: 'Joao Silva', cut: true }
    ]);
  });

  test('suspenso desativado muda primeiro de perfil e depois é ativado, sem corte', () => {
    const plan = planActions([service({ suspended: true, profile: 'SUSPENSO' })], [secret({ disabled: true })],
      { suspendedProfile: 'SUSPENSO', baseProfile: 'default' });
    expect(plan.actions).toEqual([
      { kind: 'enable', serviceId: 1, username: 'joao-1', secretId: '*1', clientName: 'Joao Silva' },
      { kind: 'profile', serviceId: 1, username: 'joao-1', secretId: '*1', profile: 'SUSPENSO', from: 'plano-10M', clientName: 'Joao Silva' }
    ]);
  });

  test('reativação sem perfil no plano repõe o perfil-base', () => {
    const plan = planActions([service({ profile: null })], [secret({ profile: 'SUSPENSO' })],
      { suspendedProfile: 'SUSPENSO', baseProfile: 'base-operador' });
    expect(plan.actions).toEqual([
      { kind: 'profile', serviceId: 1, username: 'joao-1', secretId: '*1', profile: 'base-operador', from: 'SUSPENSO', clientName: 'Joao Silva' }
    ]);
  });

  test('serviço reativado mas cortado no router pede reposição', () => {
    const plan = planActions([service()], [secret({ disabled: true })]);
    expect(plan.actions[0].kind).toBe('enable');
  });

  // A velocidade vive no perfil PPP, que é do operador: o secret só aponta
  // para ele. O RouterOS recusa `rate-limit` num secret ("unknown parameter").
  test('perfil desatualizado é corrigido', () => {
    const plan = planActions([service()], [secret({ profile: 'default' })]);
    expect(plan.actions).toEqual([
      { kind: 'profile', serviceId: 1, username: 'joao-1', secretId: '*1', profile: 'plano-10M', from: 'default', clientName: 'Joao Silva' }
    ]);
    expect(plan.divergences[0]).toMatchObject({ kind: 'profile', detail: 'Router no perfil default, plano pede plano-10M' });
  });

  test('plano sem perfil definido não toca no que está configurado à mão', () => {
    const plan = planActions([service({ profile: null })], [secret({ profile: 'feito-no-winbox' })]);
    expect(plan.actions).toEqual([]);
  });

  test('casa pelo comment mesmo que alguém tenha renomeado o utilizador no router', () => {
    const plan = planActions([service()], [secret({ name: 'renomeado-no-winbox' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.matched.get(1)?.id).toBe('*1');
    // Reportado, nunca renomeado: o equipamento do cliente autentica-se com o nome do router.
    expect(plan.divergences).toEqual([
      expect.objectContaining({ kind: 'username', serviceId: 1, username: 'joao-1' })
    ]);
  });

  test('password marcada como pendente gera uma ação sem expor a password no plano', () => {
    const plan = planActions([service({ passwordPending: true })], [secret()]);
    expect(plan.actions).toEqual([
      { kind: 'password', serviceId: 1, username: 'joao-1', secretId: '*1', clientName: 'Joao Silva' }
    ]);
    expect(plan.divergences[0]).toMatchObject({ kind: 'password', serviceId: 1 });
    expect(JSON.stringify(plan.actions)).not.toContain('segredo');
  });

  test('credenciais pendentes com outro nome no router: a mesma ação renomeia o secret', () => {
    const plan = planActions([service({ passwordPending: true })], [secret({ name: 'ana-antiga-1' })]);
    expect(plan.actions).toEqual([
      { kind: 'password', serviceId: 1, username: 'joao-1', secretId: '*1', clientName: 'Joao Silva', rename: true }
    ]);
  });

  test('sincronização isolada não chama órfãos aos outros clientes do router', () => {
    const plan = planActions(
      [service()],
      [secret(), secret({ id: '*2', name: 'ana-2', comment: 'ispm:2' })],
      { reportOrphans: false }
    );
    expect(plan.divergences).toEqual([]);
  });

  test('secret nosso sem serviço correspondente é reportado, nunca apagado', () => {
    const plan = planActions([], [secret({ id: '*9', name: 'antigo-9', comment: 'ispm:9' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.divergences[0]).toMatchObject({ kind: 'orphan_secret', serviceId: 9 });
  });

  test('secret alheio (sem a nossa marca) é ignorado por completo', () => {
    const plan = planActions([], [secret({ id: '*5', name: 'router-do-vizinho', comment: null })]);
    expect(plan.divergences).toEqual([]);
  });
});

// ------------------------------------------------------------------ passagem

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO clients (id, client_code, full_name, phone) VALUES (1, 'CL-0001', 'Joao Silva', '9110001')`).run();
  db.prepare(`
    INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
    VALUES (1, 'Base 10', '10 Mbps', '2 Mbps', 10, 2, 'plano-10M')
  `).run();
  return db;
}

function addService(db: Database.Database, id: number, status: string, username: string | null) {
  db.prepare(`
    INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username, pppoe_password)
    VALUES (?, 1, 1, 3000, ?, ?, 'senha')
  `).run(id, status, username);
}

function setting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function recordingTransport(
  secrets: RouterSecret[],
  active: Array<{ id: string; name: string }> = [],
  profiles: string[] = ['default', 'plano-10M', 'SUSPENSO']
) {
  const calls: RouterRequest[] = [];
  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    if (req.path.startsWith('/ppp/profile?')) {
      return profiles.map((name, index) => ({ '.id': `*P${index}`, name }));
    }
    if (req.path.startsWith('/ppp/secret?')) {
      return secrets.map((s) => ({
        '.id': s.id,
        name: s.name,
        disabled: String(s.disabled),
        profile: s.profile ?? undefined,
        comment: s.comment ?? undefined
      }));
    }
    if (req.path.startsWith('/ppp/active?')) {
      return active.map((session) => ({ '.id': session.id, name: session.name, address: '10.0.0.9', uptime: '1h' }));
    }
    if (req.method === 'PUT') return { '.id': '*77' };
    return null;
  }) as RouterTransport;
  return { transport, calls };
}

describe('runNetworkEnforcement', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = memoryDb();
  });

  test('serviços sem utilizador PPPoE são ignorados sem rebentar', () => {
    addService(db, 1, 'active', null);
    expect(loadDesiredServices(db)).toEqual([]);
  });

  test('o ensaio calcula tudo e não escreve uma única vez no router', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }]);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: true, maxDisables: 5 });

    expect(summary.planned).toBe(1);
    expect(summary.applied).toBe(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    // Mesmo em ensaio, o estado lido fica guardado: serve para o painel.
    const state = db.prepare('SELECT * FROM service_network_state WHERE service_id = 1').get() as {
      online: number; divergence: string; router_enabled: number;
    };
    expect(state.online).toBe(1);
    expect(state.divergence).toBe('profile');
    expect(state.router_enabled).toBe(1);
  });

  test('suspender aplica o perfil, derruba a sessão e deixa rasto', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }]);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.applied).toBe(1);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'SUSPENSO' } });
    expect(calls).not.toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    const event = db.prepare(`SELECT event_type FROM service_events WHERE service_id = 1`).get() as { event_type: string };
    expect(event.event_type).toBe('corte_rede');
    const audit = db.prepare(`SELECT action, actor_username FROM audit_logs`).get() as { action: string; actor_username: string };
    expect(audit).toMatchObject({ action: 'network_profile', actor_username: 'sistema' });
  });

  test('aprovisiona o secret em falta com a velocidade do plano', async () => {
    addService(db, 1, 'active', 'joao-1');
    const { transport, calls } = recordingTransport([]);

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls).toContainEqual({
      method: 'PUT',
      path: '/ppp/secret',
      body: { name: 'joao-1', password: 'senha', service: 'pppoe', comment: 'ispm:1', profile: 'plano-10M' }
    });
  });

  test('secret criado para um serviço já suspenso nasce ativo em SUSPENSO', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([]);

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls).toContainEqual({ method: 'PUT', path: '/ppp/secret',
      body: { name: 'joao-1', password: 'senha', service: 'pppoe', comment: 'ispm:1', profile: 'SUSPENSO' } });
    expect(calls.some((call) => call.method === 'PATCH' && call.path === '/ppp/secret/*77')).toBe(false);
  });

  test('secret desativado de suspenso recebe o perfil antes de ser ativado', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret({ disabled: true })]);
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 0 });
    expect(summary.aborted).toBeUndefined();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'SUSPENSO' } },
      { method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'no' } }
    ]);
    expect(db.prepare('SELECT desired_enabled FROM service_network_state WHERE service_id = 1').get())
      .toEqual({ desired_enabled: 1 });
  });

  test('falha no perfil impede a ativação do mesmo serviço', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const base = recordingTransport([secret({ disabled: true })]);
    const transport = (async (req: RouterRequest) => {
      if (req.method === 'PATCH' && typeof req.body === 'object' && req.body !== null && 'profile' in req.body)
        throw new Error('perfil inexistente');
      return base.transport(req);
    }) as RouterTransport;
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(summary.failed).toBe(1);
    expect(base.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(db.prepare('SELECT last_error FROM service_network_state WHERE service_id = 1').get())
      .toEqual({ last_error: 'perfil inexistente' });
  });

  test('definição vazia desativa um suspenso como antes', async () => {
    setting(db, 'routerosSuspendedProfile', '');
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret()]);
    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
  });

  test('perfil de suspensão inexistente no router: o suspenso é desativado, não fica com o plano', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }], ['default', 'plano-10M']);
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(calls).not.toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'SUSPENSO' } });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    expect(summary.failed).toBe(1);
    expect(db.prepare('SELECT last_error FROM service_network_state WHERE service_id = 1').get())
      .toMatchObject({ last_error: expect.stringContaining('não existe no router') });
  });

  test('perfil de suspensão em falta continua sujeito à trava de cortes', async () => {
    for (let id = 1; id <= 6; id += 1) addService(db, id, 'suspended', `cliente-${id}`);
    const secrets = Array.from({ length: 6 }, (_, index) => {
      const id = index + 1;
      return secret({ id: `*${id}`, name: `cliente-${id}`, comment: `ispm:${id}` });
    });
    const { transport, calls } = recordingTransport(secrets, [], ['default', 'plano-10M']);
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(summary.aborted).toBe(true);
    expect(summary.applied).toBe(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('falha no PATCH do perfil de suspensão desativa o secret que ainda está ativo', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const base = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }]);
    const transport = (async (req: RouterRequest) => {
      if (req.method === 'PATCH' && typeof req.body === 'object' && req.body !== null && 'profile' in req.body)
        throw new Error('perfil inexistente');
      return base.transport(req);
    }) as RouterTransport;

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.failed).toBe(1);
    expect(base.calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(base.calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    expect(db.prepare('SELECT last_error FROM service_network_state WHERE service_id = 1').get())
      .toEqual({ last_error: 'perfil inexistente' });
  });

  test('perfil do plano ainda inexistente no router: o serviço ativo não é criado nem ativado', async () => {
    addService(db, 1, 'active', 'joao-1');
    addService(db, 2, 'active', 'joao-2');
    addService(db, 3, 'cancelled', 'joao-3');
    const { transport, calls } = recordingTransport(
      [secret({ id: '*2', name: 'joao-2', comment: 'ispm:2', disabled: true }), secret({ id: '*3', name: 'joao-3', comment: 'ispm:3' })],
      [],
      ['default', 'SUSPENSO']
    );

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(calls).not.toContainEqual({ method: 'PATCH', path: '/ppp/secret/*2', body: { disabled: 'no' } });
    // Quem deve ficar sem acesso continua a ser cortado.
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*3', body: { disabled: 'yes' } });
    expect(summary.failed).toBe(2);
    expect(db.prepare('SELECT last_error AS lastError FROM service_network_state WHERE service_id = 1').get())
      .toEqual({ lastError: expect.stringContaining('plano-10M') });
  });

  test('cancelado continua a desativar o secret', async () => {
    addService(db, 1, 'cancelled', 'joao-1');
    const { transport, calls } = recordingTransport([secret()]);
    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
  });

  test('seis cortes por perfil excedem a trava e saltam todas as ações desses serviços', async () => {
    for (let id = 1; id <= 6; id += 1) {
      addService(db, id, 'suspended', `cliente-${id}`);
      db.prepare('UPDATE services SET pppoe_password_sync_pending = 1 WHERE id = ?').run(id);
    }
    const secrets = Array.from({ length: 6 }, (_, index) => {
      const id = index + 1;
      return secret({ id: `*${id}`, name: `cliente-${id}`, comment: `ispm:${id}` });
    });
    const { transport, calls } = recordingTransport(secrets);
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(summary.aborted).toBe(true);
    expect(summary.applied).toBe(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('sair de SUSPENSO repõe o plano, derruba a sessão e regista reposição', async () => {
    addService(db, 1, 'active', 'joao-1');
    const { transport, calls } = recordingTransport([secret({ profile: 'SUSPENSO' })], [{ id: '*A', name: 'joao-1' }]);
    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'plano-10M' } });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    expect(db.prepare('SELECT event_type FROM service_events WHERE service_id = 1').get())
      .toEqual({ event_type: 'reposicao_rede' });
  });

  test('troca entre perfis de planos normais não derruba a sessão', async () => {
    addService(db, 1, 'active', 'joao-1');
    const { transport, calls } = recordingTransport([secret({ profile: 'plano-5M' })], [{ id: '*A', name: 'joao-1' }]);
    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'plano-10M' } });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(db.prepare('SELECT count(*) AS total FROM service_events WHERE service_id = 1').get())
      .toEqual({ total: 0 });
  });

  test('reativação sem perfil no plano sai de SUSPENSO para o perfil-base', async () => {
    setting(db, 'routerosBaseProfile', 'base-operador');
    db.prepare('UPDATE internet_plans SET router_profile = NULL WHERE id = 1').run();
    addService(db, 1, 'active', 'joao-1');
    const { transport, calls } = recordingTransport([secret({ profile: 'SUSPENSO' })]);
    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { profile: 'base-operador' } });
  });

  test('password pendente é aplicada no router e a marca só limpa depois do PATCH', async () => {
    addService(db, 1, 'active', 'joao-1');
    db.prepare(`
      UPDATE services
      SET pppoe_password = 'nova-senha-segura', pppoe_password_sync_pending = 1
      WHERE id = 1
    `).run();
    const { transport, calls } = recordingTransport([secret()]);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.applied).toBe(1);
    expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/ppp/secret/*1',
      body: { password: 'nova-senha-segura' }
    });
    expect(db.prepare('SELECT pppoe_password_sync_pending AS pending FROM services WHERE id = 1').get())
      .toEqual({ pending: 0 });
  });

  test('dry-run mostra a password pendente mas não a limpa nem escreve no router', async () => {
    addService(db, 1, 'active', 'joao-1');
    db.prepare(`UPDATE services SET pppoe_password_sync_pending = 1 WHERE id = 1`).run();
    const { transport, calls } = recordingTransport([secret()]);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: true, maxDisables: 5 });

    expect(summary.actions.some((action) => action.kind === 'password')).toBe(true);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(db.prepare('SELECT pppoe_password_sync_pending AS pending FROM services WHERE id = 1').get())
      .toEqual({ pending: 1 });
  });

  test('a trava de segurança impede um corte em massa e não corta nenhum', async () => {
    for (let id = 1; id <= 4; id += 1) addService(db, id, 'suspended', `cliente-${id}`);
    const secrets = [1, 2, 3, 4].map((id) => secret({ id: `*${id}`, name: `cliente-${id}`, comment: `ispm:${id}` }));
    const { transport, calls } = recordingTransport(secrets);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 2 });

    expect(summary.aborted).toBe(true);
    expect(summary.applied).toBe(0);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('com a trava ativa, quem pagou é reposto na mesma e ninguém é cortado', async () => {
    for (let id = 1; id <= 3; id += 1) addService(db, id, 'suspended', `cliente-${id}`);
    addService(db, 4, 'active', 'cliente-4');
    const secrets = [1, 2, 3].map((id) => secret({ id: `*${id}`, name: `cliente-${id}`, comment: `ispm:${id}` }));
    secrets.push(secret({ id: '*4', name: 'cliente-4', comment: 'ispm:4', disabled: true }));
    const { transport, calls } = recordingTransport(secrets);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 2 });

    expect(summary.aborted).toBe(true);
    expect(summary.applied).toBe(1);
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
      { method: 'PATCH', path: '/ppp/secret/*4', body: { disabled: 'no' } }
    ]);
  });

  test('utilizador renomeado: o corte derruba a sessão pelo nome que está no router', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport(
      [secret({ name: 'joao-antigo' })],
      [{ id: '*A', name: 'joao-antigo' }]
    );

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.applied).toBe(1);
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    expect(db.prepare('SELECT divergence FROM service_network_state WHERE service_id = 1').get())
      .toEqual({ divergence: 'profile' });
  });

  test('reinstalação: renomeia o secret, muda a password e derruba a sessão do inquilino anterior', async () => {
    addService(db, 1, 'active', 'joao-1');
    db.prepare(`UPDATE services SET pppoe_password = 'senha-nova-123', pppoe_password_sync_pending = 1 WHERE id = 1`).run();
    const { transport, calls } = recordingTransport(
      [secret({ name: 'ana-antiga-1' })],
      [{ id: '*A', name: 'ana-antiga-1' }]
    );

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.failed).toBe(0);
    expect(calls).toContainEqual({
      method: 'PATCH',
      path: '/ppp/secret/*1',
      body: { name: 'joao-1', password: 'senha-nova-123' }
    });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    expect(db.prepare('SELECT pppoe_password_sync_pending AS pending FROM services WHERE id = 1').get())
      .toEqual({ pending: 0 });
  });

  test('só a password mudou: não renomeia nem derruba a sessão', async () => {
    addService(db, 1, 'active', 'joao-1');
    db.prepare(`UPDATE services SET pppoe_password = 'senha-nova-123', pppoe_password_sync_pending = 1 WHERE id = 1`).run();
    const { transport, calls } = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }]);

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/ppp/secret/*1', body: { password: 'senha-nova-123' } }
    ]);
  });

  test('password alterada durante o PATCH continua pendente', async () => {
    addService(db, 1, 'active', 'joao-1');
    db.prepare(`UPDATE services SET pppoe_password = 'primeira-senha', pppoe_password_sync_pending = 1 WHERE id = 1`).run();
    const base = recordingTransport([secret()]);
    const transport = (async (req: RouterRequest) => {
      if (req.method === 'PATCH') {
        // O operador grava outra password enquanto a primeira vai a caminho.
        db.prepare(`UPDATE services SET pppoe_password = 'segunda-senha', pppoe_password_sync_pending = 1 WHERE id = 1`).run();
      }
      return base.transport(req);
    }) as RouterTransport;

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(db.prepare('SELECT pppoe_password_sync_pending AS pending FROM services WHERE id = 1').get())
      .toEqual({ pending: 1 });
  });

  test('uma ação que falha fica registada no serviço e não afeta as outras', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    addService(db, 2, 'suspended', 'ana-2');
    const secrets = [secret(), secret({ id: '*2', name: 'ana-2', comment: 'ispm:2' })];
    const base = recordingTransport(secrets);
    const transport = (async (req: RouterRequest) => {
      if (req.method === 'PATCH' && req.path.endsWith('*1')) throw new Error('router inacessivel');
      return base.transport(req);
    }) as RouterTransport;

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.applied).toBe(1);
    expect(summary.failed).toBe(1);
    const failed = db.prepare('SELECT last_error FROM service_network_state WHERE service_id = 1').get() as { last_error: string };
    expect(failed.last_error).toContain('router inacessivel');
    const ok = db.prepare('SELECT last_error FROM service_network_state WHERE service_id = 2').get() as { last_error: string | null };
    expect(ok.last_error).toBeNull();
  });

  test('sem serviços com PPPoE não fala com o router de todo', async () => {
    const { transport, calls } = recordingTransport([]);
    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });
    expect(summary.skipped).toBe(true);
    expect(calls).toEqual([]);
  });
});

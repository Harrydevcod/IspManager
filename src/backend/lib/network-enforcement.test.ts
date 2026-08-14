import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  loadDesiredServices,
  planActions,
  rateLimitFor,
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
    enabled: true,
    rateLimit: '2M/10M',
    ...overrides
  };
}

function secret(overrides: Partial<RouterSecret> = {}): RouterSecret {
  return {
    id: '*1',
    name: 'joao-1',
    disabled: false,
    profile: null,
    rateLimit: '2M/10M',
    comment: 'ispm:1',
    ...overrides
  };
}

describe('rateLimitFor', () => {
  test('só devolve limite com os dois números; caso contrário não adivinha', () => {
    expect(rateLimitFor(2, 10)).toBe('2M/10M');
    expect(rateLimitFor(null, 10)).toBeNull();
    expect(rateLimitFor(2, null)).toBeNull();
    expect(rateLimitFor(0, 10)).toBeNull();
  });
});

describe('planActions', () => {
  test('serviço ativo e coerente com o router não gera ação nenhuma', () => {
    const plan = planActions([service()], [secret()]);
    expect(plan.actions).toEqual([]);
    expect(plan.divergences).toEqual([]);
  });

  test('serviço sem secret no router pede aprovisionamento', () => {
    const plan = planActions([service()], []);
    expect(plan.actions).toEqual([
      { kind: 'create', serviceId: 1, username: 'joao-1', rateLimit: '2M/10M', clientName: 'Joao Silva' }
    ]);
    expect(plan.divergences[0].kind).toBe('missing_secret');
  });

  test('serviço suspenso ainda ativo no router pede corte', () => {
    const plan = planActions([service({ enabled: false })], [secret()]);
    expect(plan.actions).toEqual([
      { kind: 'disable', serviceId: 1, username: 'joao-1', secretId: '*1', clientName: 'Joao Silva' }
    ]);
  });

  test('serviço reativado mas cortado no router pede reposição', () => {
    const plan = planActions([service()], [secret({ disabled: true })]);
    expect(plan.actions[0].kind).toBe('enable');
  });

  test('velocidade desatualizada é corrigida', () => {
    const plan = planActions([service()], [secret({ rateLimit: '1M/5M' })]);
    expect(plan.actions).toEqual([
      { kind: 'rate_limit', serviceId: 1, username: 'joao-1', secretId: '*1', rateLimit: '2M/10M', clientName: 'Joao Silva' }
    ]);
  });

  test('plano sem velocidade definida não toca no que está configurado à mão', () => {
    const plan = planActions([service({ rateLimit: null })], [secret({ rateLimit: '7M/7M' })]);
    expect(plan.actions).toEqual([]);
  });

  test('casa pelo comment mesmo que alguém tenha renomeado o utilizador no router', () => {
    const plan = planActions([service()], [secret({ name: 'renomeado-no-winbox' })]);
    expect(plan.actions).toEqual([]);
    expect(plan.matched.get(1)?.id).toBe('*1');
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
    INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps)
    VALUES (1, 'Base 10', '10 Mbps', '2 Mbps', 10, 2)
  `).run();
  return db;
}

function addService(db: Database.Database, id: number, status: string, username: string | null) {
  db.prepare(`
    INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username, pppoe_password)
    VALUES (?, 1, 1, 3000, ?, ?, 'senha')
  `).run(id, status, username);
}

function recordingTransport(secrets: RouterSecret[], active: Array<{ id: string; name: string }> = []) {
  const calls: RouterRequest[] = [];
  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    if (req.path.startsWith('/ppp/secret?')) {
      return secrets.map((s) => ({
        '.id': s.id,
        name: s.name,
        disabled: String(s.disabled),
        'rate-limit': s.rateLimit ?? undefined,
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
    expect(state.divergence).toBe('state');
    expect(state.router_enabled).toBe(1);
  });

  test('cortar desativa o secret, derruba a sessão e deixa rasto', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([secret()], [{ id: '*A', name: 'joao-1' }]);

    const summary = await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(summary.applied).toBe(1);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(calls).toContainEqual({ method: 'DELETE', path: '/ppp/active/*A' });
    const event = db.prepare(`SELECT event_type FROM service_events WHERE service_id = 1`).get() as { event_type: string };
    expect(event.event_type).toBe('corte_rede');
    const audit = db.prepare(`SELECT action, actor_username FROM audit_logs`).get() as { action: string; actor_username: string };
    expect(audit).toMatchObject({ action: 'network_disable', actor_username: 'sistema' });
  });

  test('aprovisiona o secret em falta com a velocidade do plano', async () => {
    addService(db, 1, 'active', 'joao-1');
    const { transport, calls } = recordingTransport([]);

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls).toContainEqual({
      method: 'PUT',
      path: '/ppp/secret',
      body: { name: 'joao-1', password: 'senha', service: 'pppoe', comment: 'ispm:1', 'rate-limit': '2M/10M' }
    });
  });

  test('secret criado para um serviço já suspenso nasce cortado', async () => {
    addService(db, 1, 'suspended', 'joao-1');
    const { transport, calls } = recordingTransport([]);

    await runNetworkEnforcement(db, { transport, dryRun: false, maxDisables: 5 });

    expect(calls).toContainEqual({ method: 'PATCH', path: '/ppp/secret/*77', body: { disabled: 'yes' } });
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

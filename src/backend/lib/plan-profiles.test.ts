import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { applyPlanProfile, planProfileAction, rateLimitFor, type PlanForProfile } from './plan-profiles';
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

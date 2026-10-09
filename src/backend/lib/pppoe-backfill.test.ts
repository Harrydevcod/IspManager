import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { loadDesiredServices, planActions } from './network-enforcement';
import { applyPppoeBackfill, planPppoeBackfill, type BackfillService, type TakenPppoeNames } from './pppoe-backfill';
import type { RouterSecret } from './routeros';
import { readPppoeSecret, writePppoeSecret } from './secrets';
import { freePppoeUsername, pppoeUsernameFor } from './services';

function candidate(serviceId: number, clientCode: string, overrides: Partial<BackfillService> = {}): BackfillService {
  return { serviceId, clientCode, clientName: `Cliente ${clientCode}`, status: 'active', clientStatus: 'active', username: null, ...overrides };
}

function taken(router: string[] = [], ispm: string[] = [], routerServiceIds: number[] = []): TakenPppoeNames {
  return { router: new Set(router), ispm: new Set(ispm), routerServiceIds: new Set(routerServiceIds) };
}

describe('pppoeUsernameFor', () => {
  const base = { clientName: 'João Silva', serviceId: 12 };

  test('com prefixo, o nome sai do número do código do cliente', () => {
    expect(pppoeUsernameFor({ ...base, prefix: 'skn', clientCode: 'C0002' })).toBe('skn002');
    expect(pppoeUsernameFor({ ...base, prefix: 'skn', clientCode: 'C0031' })).toBe('skn031');
    expect(pppoeUsernameFor({ ...base, prefix: 'skn', clientCode: 'C1000' })).toBe('skn1000');
  });

  test('sem prefixo ou sem número no código fica o nome de sempre', () => {
    expect(pppoeUsernameFor({ ...base, prefix: '', clientCode: 'C0002' })).toBe('joao-silva-12');
    expect(pppoeUsernameFor({ ...base, prefix: 'skn', clientCode: 'VIP' })).toBe('joao-silva-12');
  });
});

describe('planPppoeBackfill', () => {
  test('cria pelo código e salta o nome que já existe no router', () => {
    const plan = planPppoeBackfill([candidate(3, 'C0001'), candidate(4, 'C0002')], taken(['skn001']), 'skn');
    expect(plan.create).toEqual([{ serviceId: 4, clientCode: 'C0002', clientName: 'Cliente C0002', username: 'skn002' }]);
    expect(plan.skipped).toEqual([
      { serviceId: 3, clientCode: 'C0001', clientName: 'Cliente C0001', username: 'skn001', reason: 'nome já existe no router' }
    ]);
  });

  test('salta o nome já usado no ISPM, o repetido na mesma passagem e o código sem número', () => {
    const plan = planPppoeBackfill(
      [candidate(1, 'C0005'), candidate(2, 'C0006'), candidate(3, 'C0006'), candidate(4, 'VIP')],
      taken([], ['skn005']),
      'skn'
    );
    expect(plan.create.map((row) => row.serviceId)).toEqual([2]);
    expect(plan.skipped.map((row) => [row.serviceId, row.reason])).toEqual([
      [1, 'nome já usado no ISPM'],
      [3, 'nome já usado no ISPM'],
      [4, 'código sem número']
    ]);
  });

  test('salta o serviço que já tem secret ancorado pelo comentário', () => {
    const plan = planPppoeBackfill([candidate(7, 'C0007')], taken(['outro-nome'], [], [7]), 'skn');
    expect(plan.create).toEqual([]);
    expect(plan.skipped[0].reason).toBe('nome já existe no router');
  });

  test('quem já tem utilizador, não está ativo ou é de cliente cancelado nem entra', () => {
    const plan = planPppoeBackfill([
      candidate(1, 'C0001', { username: 'skn001' }),
      candidate(2, 'C0002', { status: 'cancelled' }),
      candidate(3, 'C0003', { status: 'suspended' }),
      candidate(4, 'C0004', { clientStatus: 'cancelled' })
    ], taken(), 'skn');
    expect(plan).toEqual({ create: [], skipped: [] });
  });
});

describe('na base de dados', () => {
  let db: Database.Database;

  // O parque real em miniatura: a Cibel (C0014) já tem o skn001 que a regra daria à C0001.
  const liveSecret: RouterSecret = { id: '*1', name: 'skn001', disabled: false, profile: 'plano-10M', comment: 'ispm:14 Cibel Restaurante' };

  function rows(): BackfillService[] {
    return db.prepare(`
      SELECT s.id AS serviceId, s.status, s.pppoe_username AS username,
        c.client_code AS clientCode, c.full_name AS clientName, c.status AS clientStatus
      FROM services s JOIN clients c ON c.id = s.client_id ORDER BY s.id
    `).all() as BackfillService[];
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
      VALUES (1, 'Base 10', '10 Mbps', '2 Mbps', 10, 2, 'plano-10M')
    `).run();
    const client = db.prepare(`INSERT INTO clients (id, client_code, full_name, phone) VALUES (?, ?, ?, ?)`);
    const service = db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (?, ?, 1, 2500, ?, ?)`);
    client.run(1, 'C0001', 'Isa Rafe', '9110001');
    client.run(2, 'C0002', 'Ana Lima', '9110002');
    client.run(14, 'C0014', 'Cibel Restaurante', '9110014');
    service.run(3, 1, 'active', null);
    service.run(4, 2, 'active', null);
    service.run(15, 14, 'active', 'skn001');
    writePppoeSecret(db, 15, 'senha-da-cibel');
    db.prepare('UPDATE services SET pppoe_password_sync_pending = 0 WHERE id = 15').run();
  });

  test('grava nome e senha selada só nas linhas sem utilizador', () => {
    const before = db.prepare('SELECT pppoe_username, pppoe_password, pppoe_password_sync_pending FROM services WHERE id = 15').get();
    const plan = planPppoeBackfill(rows(), taken([liveSecret.name], ['skn001'], [15]), 'skn');

    expect(applyPppoeBackfill(db, plan)).toBe(1);
    expect(db.prepare('SELECT pppoe_username AS u, pppoe_password_sync_pending AS p FROM services WHERE id = 4').get())
      .toEqual({ u: 'skn002', p: 1 });
    expect(readPppoeSecret(db, 4).length).toBeGreaterThanOrEqual(8);
    expect(db.prepare('SELECT pppoe_username AS u FROM services WHERE id = 3').get()).toEqual({ u: null });
    expect(db.prepare('SELECT pppoe_username, pppoe_password, pppoe_password_sync_pending FROM services WHERE id = 15').get())
      .toEqual(before);
  });

  test('repetir o plano não reescreve quem entretanto ganhou utilizador', () => {
    const plan = planPppoeBackfill(rows(), taken([liveSecret.name], ['skn001'], [15]), 'skn');
    applyPppoeBackfill(db, plan);
    const sealed = db.prepare('SELECT pppoe_password AS s FROM services WHERE id = 4').get();
    expect(applyPppoeBackfill(db, plan)).toBe(0);
    expect(db.prepare('SELECT pppoe_password AS s FROM services WHERE id = 4').get()).toEqual(sealed);
  });

  test('principal é o primeiro serviço com PPPoE do cliente, e só se o número for só dele', () => {
    const service = db.prepare(`INSERT INTO services (id, client_id, plan_id, monthly_value_cve, status, pppoe_username) VALUES (?, ?, 1, 2500, 'active', ?)`);
    service.run(16, 14, 'skn014-16');
    const primaries = () => Object.fromEntries(loadDesiredServices(db).map((item) => [item.serviceId, item.primary]));
    expect(primaries()).toEqual({ 15: true, 16: false });

    db.prepare(`INSERT INTO clients (id, client_code, full_name, phone) VALUES (20, 'X-14', 'Outro Catorze', '9110020')`).run();
    service.run(17, 20, 'outro-17');
    expect(primaries()).toEqual({ 15: false, 16: false, 17: false });
  });

  test('cliente já ancorado no router pelo número não ganha utilizador novo', () => {
    const plan = planPppoeBackfill(rows(), { router: new Set(['renomeado']), ispm: new Set(['skn001']), routerClientNumbers: new Set([2]) }, 'skn');
    expect(plan.create).toEqual([]);
    expect(plan.skipped).toContainEqual(expect.objectContaining({ serviceId: 4, reason: 'nome já existe no router' }));
  });

  test('a reconciliação seguinte só cria: nenhum secret existente é tocado', () => {
    applyPppoeBackfill(db, planPppoeBackfill(rows(), taken([liveSecret.name], ['skn001'], [15]), 'skn'));
    const { actions } = planActions(loadDesiredServices(db), [liveSecret]);
    expect(actions).toEqual([
      { kind: 'create', serviceId: 4, username: 'skn002', profile: 'plano-10M', clientName: 'Ana Lima' }
    ]);
  });

  test('o nome automático de um serviço novo nunca repete o de outro serviço', () => {
    const input = { prefix: 'skn', clientCode: 'C0001', clientName: 'Isa Rafe', serviceId: 3 };
    expect(freePppoeUsername(db, input)).toBe('skn001-3');
    // O próprio serviço não colide consigo.
    expect(freePppoeUsername(db, { ...input, serviceId: 15 })).toBe('skn001');
    expect(freePppoeUsername(db, { ...input, clientCode: 'C0002', serviceId: 4 })).toBe('skn002');
  });
});

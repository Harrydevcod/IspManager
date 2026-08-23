import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildMonthlyServiceLines, type RentalLine } from './billing';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let billing: typeof import('./billing');

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-rental-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  billing = await import('./billing');
});

beforeEach(() => {
  // Child-first: as chaves estrangeiras estão ligadas em runtime, e a instalação
  // escreve movimentos de stock e eventos que apontam para serviço e catálogo.
  for (const table of [
    'service_device_shares',
    'stock_movements',
    'service_material_lines',
    'service_install_costs',
    'service_events',
    'service_device_assignments',
    'payment_lines',
    'payments',
    'services',
    'clients',
    'equipment_catalog',
    'internet_plans'
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

// ------------------------------------------------------------------ seeds

function seedCatalog(model: string, rentalCve: number, sellingCve = 0): number {
  return Number(db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, stock_total, rental_fee_cve, selling_price_cve)
    VALUES ('equipamento', 'antena', 'TP-Link', ?, 5, ?, ?)
  `).run(model, rentalCve, sellingCve).lastInsertRowid);
}

function seedService(name: string, monthlyCve = 2500): { serviceId: number; clientId: number } {
  const planId = Number(db.prepare(`
    INSERT INTO internet_plans (name, monthly_price_cve, active) VALUES ('PLANO', ?, 1)
  `).run(monthlyCve).lastInsertRowid);
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`C${name}`, name).lastInsertRowid);
  const serviceId = Number(db.prepare(`
    INSERT INTO services (client_id, plan_id, status, monthly_value_cve, due_day)
    VALUES (?, ?, 'active', ?, 10)
  `).run(clientId, planId, monthlyCve).lastInsertRowid);
  return { serviceId, clientId };
}

function assign(serviceId: number, catalogId: number, over: { rentalFeeCve?: number; ownership?: string; endDate?: string | null } = {}): number {
  const catalogRental = db.prepare('SELECT rental_fee_cve AS r FROM equipment_catalog WHERE id = ?')
    .get(catalogId) as { r: number };
  return Number(db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date, ownership, rental_fee_cve)
    VALUES (?, ?, date('now'), ?, ?, ?)
  `).run(
    serviceId,
    catalogId,
    over.endDate ?? null,
    over.ownership ?? 'isp',
    over.rentalFeeCve ?? catalogRental.r
  ).lastInsertRowid);
}

// ---------------------------------------------- composição da fatura (pura)

describe('buildMonthlyServiceLines — aluguer', () => {
  const svc = { monthlyValueCve: 2500, audiovisualMode: 'none' as const, audiovisualMonthlyCve: 0 };
  const rental = (label: string, amountCve: number, assignmentId = 1): RentalLine =>
    ({ assignmentId, label, amountCve });

  test('sem equipamento alugado, a fatura é só o plano', () => {
    const lines = buildMonthlyServiceLines(svc, 'AV', []);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('internet');
  });

  test('uma linha por equipamento, com o modelo no texto', () => {
    const lines = buildMonthlyServiceLines(svc, 'AV', [
      rental('TP-Link CPE 510', 250, 1),
      rental('TP-Link TL-S5-5KM', 500, 2)
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['internet', 'aluguer', 'aluguer']);
    expect(lines[1].description).toBe('Aluguer — TP-Link CPE 510');
    expect(billing.sumLines(lines)).toBe(3250);
  });

  test('aluguer a zero não gera linha vazia na fatura', () => {
    const lines = buildMonthlyServiceLines(svc, 'AV', [rental('Cabo', 0)]);
    expect(lines).toHaveLength(1);
  });

  test('o aluguer entra depois do audiovisual, não antes', () => {
    const lines = buildMonthlyServiceLines(
      { monthlyValueCve: 2500, audiovisualMode: 'monthly', audiovisualMonthlyCve: 1000 },
      'Audiovisual',
      [rental('CPE 510', 250)]
    );
    expect(lines.map((l) => l.kind)).toEqual(['internet', 'audiovisual', 'aluguer']);
  });

  test('suspenso paga o aluguer mas não o plano nem o audiovisual', () => {
    const lines = buildMonthlyServiceLines(
      { monthlyValueCve: 2500, audiovisualMode: 'monthly', audiovisualMonthlyCve: 1000, status: 'suspended' },
      'Audiovisual',
      [rental('CPE 510', 250)]
    );
    expect(lines.map((l) => l.kind)).toEqual(['aluguer']);
    expect(billing.sumLines(lines)).toBe(250);
  });

  test('suspenso que já devolveu o equipamento não gera linha nenhuma', () => {
    const lines = buildMonthlyServiceLines({ ...svc, status: 'suspended' }, 'AV', []);
    expect(lines).toHaveLength(0);
  });
});

// ------------------------------------------------------- que equipamento conta

describe('loadServiceRentals', () => {
  test('conta o equipamento instalado e do ISP', () => {
    const { serviceId } = seedService('Anilsa');
    assign(serviceId, seedCatalog('MW325R', 250));
    assign(serviceId, seedCatalog('TL-S5-5KM', 500));

    const rentals = billing.loadServiceRentals(db).get(serviceId)!;
    expect(rentals.map((r) => r.amountCve).sort()).toEqual([250, 500]);
    expect(rentals[0].label).toContain('TP-Link');
  });

  test('equipamento já retirado não gera renda', () => {
    const { serviceId } = seedService('Retirado');
    assign(serviceId, seedCatalog('CPE 510', 250), { endDate: '2026-01-31' });
    expect(billing.loadServiceRentals(db).get(serviceId)).toBeUndefined();
  });

  test('equipamento do cliente não gera renda — é o coração da funcionalidade', () => {
    const { serviceId } = seedService('Dono');
    assign(serviceId, seedCatalog('CPE 510', 250), { ownership: 'cliente' });
    expect(billing.loadServiceRentals(db).get(serviceId)).toBeUndefined();
  });

  test('material sem renda não aparece', () => {
    const { serviceId } = seedService('Cabos');
    assign(serviceId, seedCatalog('Cabo Utp', 0));
    expect(billing.loadServiceRentals(db).get(serviceId)).toBeUndefined();
  });

  test('a renda é o instantâneo da atribuição, não o preço atual do catálogo', () => {
    const { serviceId } = seedService('Congelado');
    const catalogId = seedCatalog('CPE 510', 250);
    assign(serviceId, catalogId);
    // O catálogo sobe para 400 — quem já tem instalado continua a pagar 250.
    db.prepare('UPDATE equipment_catalog SET rental_fee_cve = 400 WHERE id = ?').run(catalogId);
    expect(billing.loadServiceRentals(db).get(serviceId)![0].amountCve).toBe(250);
  });

  test('quem entra por partilha não paga renda — paga o titular, uma vez', () => {
    const titular = seedService('Titular');
    const convidado = seedService('Convidado');
    const assignmentId = assign(titular.serviceId, seedCatalog('CPE710', 1000));
    db.prepare('INSERT INTO service_device_shares (assignment_id, service_id) VALUES (?, ?)')
      .run(assignmentId, convidado.serviceId);

    const byService = billing.loadServiceRentals(db);
    expect(byService.get(titular.serviceId)).toHaveLength(1);
    expect(byService.get(convidado.serviceId)).toBeUndefined();
  });
});

// -------------------------------------------------------- geração mensal real

describe('computeMonthlyBilling com aluguer', () => {
  test('o caso real: plano 2500 + 250 + 500 = 3250 em três linhas', () => {
    const { serviceId } = seedService('Anilsa', 2500);
    assign(serviceId, seedCatalog('MW325R', 250));
    assign(serviceId, seedCatalog('TL-S5-5KM', 500));

    const preview = billing.computeMonthlyBilling(db, '2026-08');
    const row = preview.toCreate.find((r) => r.serviceId === serviceId)!;
    expect(row.amountCve).toBe(3250);
    expect(row.lines).toHaveLength(3);
    expect(preview.totalCve).toBe(3250);
  });

  test('serviço sem mensalidade mas com equipamento alugado continua a ser faturado', () => {
    const { serviceId } = seedService('SoAluguer', 0);
    assign(serviceId, seedCatalog('CPE 510', 250));
    const row = billing.computeMonthlyBilling(db, '2026-08').toCreate.find((r) => r.serviceId === serviceId)!;
    expect(row.amountCve).toBe(250);
  });
});

// ------------------------------------------------- instalação → renda congelada

describe('installDeviceWithinTx propaga a propriedade e congela a renda', () => {
  async function install(serviceId: number, catalogId: number, ownership?: 'isp' | 'cliente') {
    const { installDeviceWithinTx } = await import('./serviceInstall');
    return db.transaction(() => installDeviceWithinTx(db, {
      serviceId,
      clientName: 'Cliente',
      device: { catalogId, ownership: ownership ?? null },
      userId: null
    }))();
  }

  test('por omissão o equipamento é do ISP e copia a renda do catálogo', async () => {
    const { serviceId } = seedService('Instalado');
    const catalogId = seedCatalog('CPE 510', 250);
    const { assignmentId } = await install(serviceId, catalogId);

    const row = db.prepare('SELECT ownership, rental_fee_cve AS rental FROM service_device_assignments WHERE id = ?')
      .get(Number(assignmentId)) as { ownership: string; rental: number };
    expect(row.ownership).toBe('isp');
    expect(row.rental).toBe(250);
    expect(billing.loadServiceRentals(db).get(serviceId)).toHaveLength(1);
  });

  test('equipamento trazido pelo cliente entra sem renda e nunca é faturado', async () => {
    const { serviceId } = seedService('Trouxe');
    const catalogId = seedCatalog('CPE 510', 250);
    const { assignmentId } = await install(serviceId, catalogId, 'cliente');

    const row = db.prepare('SELECT ownership, rental_fee_cve AS rental, owned_since AS since FROM service_device_assignments WHERE id = ?')
      .get(Number(assignmentId)) as { ownership: string; rental: number; since: string | null };
    expect(row.ownership).toBe('cliente');
    expect(row.rental).toBe(0);
    expect(row.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(billing.loadServiceRentals(db).get(serviceId)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ compra

describe('insertEquipmentPurchase', () => {
  function buy(assignmentId: number, ids: { serviceId: number; clientId: number }, amountCve: number) {
    return db.transaction(() => billing.insertEquipmentPurchase(db, {
      assignmentId,
      serviceId: ids.serviceId,
      clientId: ids.clientId,
      amountCve,
      label: 'TP-Link CPE 510'
    }))();
  }

  test('emite a cobrança, vira a propriedade e pára a renda', () => {
    const ids = seedService('Comprador');
    const assignmentId = assign(ids.serviceId, seedCatalog('CPE 510', 250, 8000));
    expect(billing.loadServiceRentals(db).get(ids.serviceId)).toHaveLength(1);

    const result = buy(assignmentId, ids, 8000);
    expect(result.paymentId).not.toBeNull();
    expect(result.alreadyOwned).toBe(false);

    const row = db.prepare('SELECT ownership, owned_since AS ownedSince FROM service_device_assignments WHERE id = ?')
      .get(assignmentId) as { ownership: string; ownedSince: string };
    expect(row.ownership).toBe('cliente');
    expect(row.ownedSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A partir daqui a fatura mensal deixa de ter a linha de aluguer.
    expect(billing.loadServiceRentals(db).get(ids.serviceId)).toBeUndefined();
  });

  test('a cobrança sai com linha própria e número de fatura', () => {
    const ids = seedService('ComLinha');
    const assignmentId = assign(ids.serviceId, seedCatalog('CPE 510', 250, 8000));
    const { paymentId } = buy(assignmentId, ids, 8000);

    const payment = db.prepare('SELECT amount_cve AS amountCve, reference_month AS ref, invoice_number AS inv FROM payments WHERE id = ?')
      .get(paymentId!) as { amountCve: number; ref: string; inv: string | null };
    expect(payment.amountCve).toBe(8000);
    expect(payment.ref).toBe(`EQUIP-${assignmentId}`);
    expect(payment.inv).toBeTruthy();

    const line = db.prepare('SELECT kind, description FROM payment_lines WHERE payment_id = ?')
      .get(paymentId!) as { kind: string; description: string };
    expect(line.kind).toBe('equipamento');
    expect(line.description).toContain('CPE 510');
  });

  test('chamar duas vezes não duplica a cobrança', () => {
    const ids = seedService('Duplo');
    const assignmentId = assign(ids.serviceId, seedCatalog('CPE 510', 250, 8000));
    buy(assignmentId, ids, 8000);
    const second = buy(assignmentId, ids, 8000);

    expect(second.alreadyOwned).toBe(true);
    expect(second.paymentId).toBeNull();
    const count = db.prepare('SELECT COUNT(*) c FROM payments WHERE service_id = ?').get(ids.serviceId) as { c: number };
    expect(count.c).toBe(1);
  });

  test('dois equipamentos do mesmo serviço podem ser comprados em alturas diferentes', () => {
    const ids = seedService('DoisPassos');
    const a1 = assign(ids.serviceId, seedCatalog('CPE 510', 250, 8000));
    const a2 = assign(ids.serviceId, seedCatalog('TL-S5', 500, 5000));

    expect(buy(a1, ids, 8000).paymentId).not.toBeNull();
    // A chave é por atribuição: a segunda compra não colide com a primeira.
    expect(buy(a2, ids, 5000).paymentId).not.toBeNull();
    const count = db.prepare('SELECT COUNT(*) c FROM payments WHERE service_id = ?').get(ids.serviceId) as { c: number };
    expect(count.c).toBe(2);
  });

  test('preço a zero vira a propriedade sem emitir fatura de 0$', () => {
    const ids = seedService('Oferecido');
    const assignmentId = assign(ids.serviceId, seedCatalog('CPE 510', 250, 8000));
    const result = buy(assignmentId, ids, 0);

    expect(result.paymentId).toBeNull();
    expect(result.alreadyOwned).toBe(false);
    const row = db.prepare('SELECT ownership FROM service_device_assignments WHERE id = ?')
      .get(assignmentId) as { ownership: string };
    expect(row.ownership).toBe('cliente');
    expect(billing.loadServiceRentals(db).get(ids.serviceId)).toBeUndefined();
  });
});

// ----------------------------------------------------- suspenso com equipamento

describe('computeMonthlyBilling — serviço suspenso', () => {
  function suspend(serviceId: number): void {
    db.prepare(`UPDATE services SET status = 'suspended' WHERE id = ?`).run(serviceId);
  }

  test('quem foi cortado e ficou com o equipamento continua a ser faturado — só a renda', () => {
    const ids = seedService('Cortado');
    assign(ids.serviceId, seedCatalog('CPE 510', 250));
    suspend(ids.serviceId);

    const preview = billing.computeMonthlyBilling(db, '2026-08');
    const row = preview.toCreate.find((item) => item.serviceId === ids.serviceId)!;
    expect(row.amountCve).toBe(250);
    expect(row.lines.map((l) => l.kind)).toEqual(['aluguer']);
    // O suspenso entra na fatura mas não conta como serviço ativo.
    expect(preview.activeServices).toBe(0);
  });

  test('suspenso sem equipamento do ISP não gera fatura', () => {
    const ids = seedService('CortadoSemNada');
    suspend(ids.serviceId);

    const preview = billing.computeMonthlyBilling(db, '2026-08');
    expect(preview.toCreate).toHaveLength(0);
  });

  test('suspenso que devolveu o equipamento deixa de ser faturado', () => {
    const ids = seedService('Devolveu');
    assign(ids.serviceId, seedCatalog('CPE 510', 250), { endDate: '2026-08-01' });
    suspend(ids.serviceId);

    expect(billing.computeMonthlyBilling(db, '2026-08').toCreate).toHaveLength(0);
  });

  test('cancelado não gera fatura, mesmo com equipamento por devolver', () => {
    const ids = seedService('Cancelado');
    assign(ids.serviceId, seedCatalog('CPE 510', 250));
    db.prepare(`UPDATE services SET status = 'cancelled' WHERE id = ?`).run(ids.serviceId);

    expect(billing.computeMonthlyBilling(db, '2026-08').toCreate).toHaveLength(0);
  });
});

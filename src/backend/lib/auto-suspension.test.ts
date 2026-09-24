import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { RouterError } from './routeros';
import {
  loadAutoSuspensionPreview,
  reactivateServiceIfEligibleAfterPayment,
  runAutomaticSuspension
} from './auto-suspension';

function dbForTest() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function set(db: Database.Database, key: string, value: string) {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

function configure(db: Database.Database, dryRun: boolean) {
  set(db, 'autoSuspensionEnabled', 'true');
  set(db, 'autoSuspensionGraceDays', '5');
  set(db, 'autoSuspensionMaxPerRun', '10');
  set(db, 'autoSuspensionMaxPercent', '100');
  set(db, 'routerosEnabled', 'true');
  set(db, 'routerosHost', '192.168.2.1');
  set(db, 'routerosUser', 'ispm');
  set(db, 'routerosDryRun', String(dryRun));
}

function seed(
  db: Database.Database,
  code: string,
  dueModifier = '-20 days'
): { clientId: number; serviceId: number; paymentId: number } {
  const clientId = Number(db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(code, `Cliente ${code}`).lastInsertRowid);

  const planId = Number(db.prepare(`
    INSERT INTO internet_plans (name, monthly_price_cve, download_mbps, upload_mbps)
    VALUES (?, 3000, 30, 10)
  `).run(`Plano ${code}`).lastInsertRowid);

  const serviceId = Number(db.prepare(`
    INSERT INTO services (
      client_id, plan_id, monthly_value_cve, due_day, status, pppoe_username, pppoe_password
    ) VALUES (?, ?, 3000, 10, 'active', ?, 'senha')
  `).run(clientId, planId, `pppoe-${code}`).lastInsertRowid);

  const paymentId = Number(db.prepare(`
    INSERT INTO payments (
      client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number
    ) VALUES (?, ?, '2026-09', 3000, date('now', ?), 'pending', ?)
  `).run(clientId, serviceId, dueModifier, `FT-${code}`).lastInsertRowid);

  return { clientId, serviceId, paymentId };
}

describe('suspensão automática por falta de pagamento', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = dbForTest();
  });

  test('respeita o período de tolerância', () => {
    configure(db, true);
    seed(db, 'DENTRO', '-3 days');

    expect(loadAutoSuspensionPreview(db).candidateCount).toBe(0);
  });

  test('dry-run encontra o devedor mas não muda o serviço', async () => {
    configure(db, true);
    const { serviceId } = seed(db, 'DRY');

    const result = await runAutomaticSuspension(db);

    expect(result.dryRun).toBe(true);
    expect(result.simulated).toBe(1);
    expect(result.applied).toBe(0);
    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(serviceId))
      .toEqual({ status: 'active' });
  });

  test('LIVE marca a origem nonpayment', async () => {
    configure(db, false);
    const { serviceId } = seed(db, 'LIVE');

    const result = await runAutomaticSuspension(db, { probeRouter: async () => undefined });

    expect(result.applied).toBe(1);
    expect(db.prepare(`
      SELECT status, suspension_source AS source, suspended_at AS suspendedAt
      FROM services WHERE id = ?
    `).get(serviceId)).toMatchObject({
      status: 'suspended',
      source: 'nonpayment',
      suspendedAt: expect.any(String)
    });
  });

  test('crédito a favor protege o cliente até revisão', async () => {
    configure(db, false);
    const { clientId, serviceId } = seed(db, 'CREDITO');
    db.prepare(`
      INSERT INTO client_credits (client_id, amount_cve, reason)
      VALUES (?, 500, 'Credito em conta')
    `).run(clientId);

    const preview = loadAutoSuspensionPreview(db);
    expect(preview.candidateCount).toBe(0);
    expect(preview.blockedByCreditCount).toBe(1);

    await runAutomaticSuspension(db, { probeRouter: async () => undefined });
    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(serviceId))
      .toEqual({ status: 'active' });
  });

  test('trava por quantidade cancela o lote inteiro', async () => {
    configure(db, false);
    set(db, 'autoSuspensionMaxPerRun', '1');
    const a = seed(db, 'A');
    const b = seed(db, 'B');

    const result = await runAutomaticSuspension(db, { probeRouter: async () => undefined });

    expect(result.aborted).toBe(true);
    expect(db.prepare('SELECT status FROM services WHERE id IN (?, ?) ORDER BY id').all(a.serviceId, b.serviceId))
      .toEqual([{ status: 'active' }, { status: 'active' }]);
  });

  test('trava por percentagem cancela o lote inteiro', async () => {
    configure(db, false);
    set(db, 'autoSuspensionMaxPercent', '20');
    const overdue = seed(db, 'OVER');
    seed(db, 'OK', '-1 days');

    const result = await runAutomaticSuspension(db, { probeRouter: async () => undefined });

    expect(result.aborted).toBe(true);
    expect(result.guardReason).toContain('%');
    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(overdue.serviceId))
      .toEqual({ status: 'active' });
  });

  test('LIVE mantém o cliente ativo quando o MikroTik está inacessível', async () => {
    configure(db, false);
    const { serviceId } = seed(db, 'SEM-REDE');

    const result = await runAutomaticSuspension(db, {
      probeRouter: async () => {
        throw new RouterError('Sem rota para o router', 0, undefined, 'ENETUNREACH');
      }
    });

    expect(result).toMatchObject({
      skipped: true,
      retryPending: true,
      routerReachable: false,
      routerFailureCode: 'ENETUNREACH',
      applied: 0
    });
    expect(result.reason).toContain('Suspensão adiada');
    expect(db.prepare('SELECT status, suspension_source AS source FROM services WHERE id = ?').get(serviceId))
      .toEqual({ status: 'active', source: null });
    expect(db.prepare(`
      SELECT action FROM audit_logs
      WHERE action = 'auto_suspension_router_unreachable'
      ORDER BY id DESC LIMIT 1
    `).get()).toEqual({ action: 'auto_suspension_router_unreachable' });
  });

  test('depois de uma falha de rede, a passagem seguinte volta a tentar e pode suspender', async () => {
    configure(db, false);
    const { serviceId } = seed(db, 'RETRY');

    await runAutomaticSuspension(db, {
      probeRouter: async () => {
        throw new RouterError('VPN em baixo', 0, undefined, 'EHOSTUNREACH');
      }
    });

    expect(db.prepare('SELECT status FROM services WHERE id = ?').get(serviceId))
      .toEqual({ status: 'active' });

    const retry = await runAutomaticSuspension(db, {
      probeRouter: async () => undefined
    });

    expect(retry).toMatchObject({ applied: 1, routerReachable: true });
    expect(db.prepare('SELECT status, suspension_source AS source FROM services WHERE id = ?').get(serviceId))
      .toEqual({ status: 'suspended', source: 'nonpayment' });
  });

  test('dry-run não exige ligação ao MikroTik e nunca chama a sonda LIVE', async () => {
    configure(db, true);
    seed(db, 'DRY-SEM-REDE');
    let probes = 0;

    const result = await runAutomaticSuspension(db, {
      probeRouter: async () => {
        probes += 1;
        throw new Error('não devia ser chamada');
      }
    });

    expect(result.dryRun).toBe(true);
    expect(result.simulated).toBe(1);
    expect(probes).toBe(0);
  });

  test('pagamento só reativa suspensão cuja origem é nonpayment', () => {
    configure(db, false);
    const automatic = seed(db, 'AUTO');
    const manual = seed(db, 'MANUAL');

    db.prepare(`
      UPDATE services SET status='suspended', suspension_source='nonpayment', suspended_at=datetime('now')
      WHERE id=?
    `).run(automatic.serviceId);
    db.prepare(`
      UPDATE services SET status='suspended', suspension_source='manual', suspended_at=datetime('now')
      WHERE id=?
    `).run(manual.serviceId);
    db.prepare(`UPDATE payments SET status='paid' WHERE id IN (?, ?)`)
      .run(automatic.paymentId, manual.paymentId);

    expect(reactivateServiceIfEligibleAfterPayment(db, automatic.serviceId)).toBe(true);
    expect(reactivateServiceIfEligibleAfterPayment(db, manual.serviceId)).toBe(false);
    expect(db.prepare('SELECT status FROM services WHERE id=?').get(automatic.serviceId))
      .toEqual({ status: 'active' });
    expect(db.prepare('SELECT status FROM services WHERE id=?').get(manual.serviceId))
      .toEqual({ status: 'suspended' });
  });

  test('dívida do titular anterior não suspende o novo titular após transferência', () => {
    configure(db, true);
    const original = seed(db, 'ANTIGO');

    const newClientId = Number(db.prepare(`
      INSERT INTO clients (client_code, full_name, status)
      VALUES ('NOVO', 'Cliente Novo', 'active')
    `).run().lastInsertRowid);

    // A transferência preserva as faturas emitidas no cliente antigo.
    db.prepare('UPDATE services SET client_id = ? WHERE id = ?')
      .run(newClientId, original.serviceId);

    const preview = loadAutoSuspensionPreview(db);
    expect(preview.candidateCount).toBe(0);
  });

  test.each(['suspended', 'cancelled'] as const)(
    'pagamento não reativa serviço quando o cliente está %s',
    (clientStatus) => {
      configure(db, false);
      const one = seed(db, 'CLIENTE-INATIVO');

      db.prepare(`
        UPDATE services
        SET status='suspended', suspension_source='nonpayment', suspended_at=datetime('now')
        WHERE id=?
      `).run(one.serviceId);
      db.prepare('UPDATE clients SET status = ? WHERE id = ?')
        .run(clientStatus, one.clientId);
      db.prepare('UPDATE payments SET status = ? WHERE id = ?')
        .run('paid', one.paymentId);

      expect(reactivateServiceIfEligibleAfterPayment(db, one.serviceId)).toBe(false);
      expect(db.prepare('SELECT status FROM services WHERE id = ?').get(one.serviceId))
        .toEqual({ status: 'suspended' });
    }
  );

  test('uma dívida antiga restante impede reativação prematura', () => {
    configure(db, false);
    const one = seed(db, 'DUAS');
    db.prepare(`
      INSERT INTO payments (
        client_id, service_id, reference_month, amount_cve, due_date, status, invoice_number
      ) VALUES (?, ?, '2026-08', 3000, date('now','-40 days'), 'pending', 'FT-DUAS-2')
    `).run(one.clientId, one.serviceId);

    db.prepare(`
      UPDATE services SET status='suspended', suspension_source='nonpayment', suspended_at=datetime('now')
      WHERE id=?
    `).run(one.serviceId);
    db.prepare(`UPDATE payments SET status='paid' WHERE id=?`).run(one.paymentId);

    expect(reactivateServiceIfEligibleAfterPayment(db, one.serviceId)).toBe(false);
  });
});

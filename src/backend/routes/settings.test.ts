import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const validSettings = {
  companyName: 'ISPM',
  nif: '',
  phone: '',
  email: '',
  address: '',
  island: '',
  defaultDueDay: 1,
  currencyCode: 'CVE',
  invoicePrefix: 'FT',
  receiptPrefix: 'RC',
  ivaRate: 15,
  fiscalRegime: 'normal',
  showIva: false,
  printQrCode: false,
  legalNotes: '',
  whatsappTemplate: 'ola',
  whatsappTestTemplate: 'teste',
  whatsappInvoiceReadyTemplate: 'fatura',
  whatsappReceiptTemplate: 'recibo',
  whatsappOverdueTemplate: 'atraso',
  whatsappSuspensionTemplate: 'suspensao',
  whatsappSuspensionNoticeDays: 15,
  autoNoticesEnabled: false,
  noticeCooldownDays: 7,
  ultraMsgInstanceId: '',
  ultraMsgToken: '',
  smsCompanionEnabled: false,
  smsCompanionBaseUrl: '',
  smsDispatchIntervalSeconds: 60,
  smsRetryGraceMinutes: 5,
  smsInvoiceIssuedTemplate: 'sms fatura',
  smsReceiptConfirmedTemplate: 'sms recibo',
  smsPaymentOverdueTemplate: 'sms atraso',
  smsSuspensionNoticeTemplate: 'sms suspensao',
  backupDir: ''
};

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-settings-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  process.env.ISPM_AUTH = 'off';

  const server = await import('../server');
  const database = await import('../db/database');

  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.prepare('DELETE FROM app_settings').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
  delete process.env.ISPM_AUTH;
});

describe('settings SMS validation', () => {
  test('accepts string false for smsCompanionEnabled without enabling SMS', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...validSettings, smsCompanionEnabled: 'false' }
    });

    expect(response.statusCode).toBe(200);
    const row = db.prepare(`SELECT value FROM app_settings WHERE key='smsCompanionEnabled'`).get() as { value: string };
    expect(row.value).toBe('false');
  });

  test('rejects public SMS companion URLs', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...validSettings, smsCompanionEnabled: true, smsCompanionBaseUrl: 'https://example.com/sms' }
    });

    expect(response.statusCode).toBe(400);
  });

  test('rejects DNS names that only look like private IPs', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...validSettings, smsCompanionEnabled: true, smsCompanionBaseUrl: 'http://10.evil.com:8765' }
    });

    expect(response.statusCode).toBe(400);
  });

  test('normalizes local SMS companion URL trailing slash', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...validSettings, smsCompanionEnabled: true, smsCompanionBaseUrl: 'http://192.168.1.50:8765/' }
    });

    expect(response.statusCode).toBe(200);
    const row = db.prepare(`SELECT value FROM app_settings WHERE key='smsCompanionBaseUrl'`).get() as { value: string };
    expect(row.value).toBe('http://192.168.1.50:8765');
  });
});

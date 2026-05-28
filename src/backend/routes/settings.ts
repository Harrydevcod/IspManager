import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { requireRole } from './auth';
import {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappTestTemplate
} from '../../shared/whatsapp';

const settingsSchema = z.object({
  companyName: z.string().trim().min(1),
  nif: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  email: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  island: z.string().trim().optional().nullable(),
  defaultDueDay: z.coerce.number().int().min(1).max(31),
  currencyCode: z.string().trim().min(1).max(8),
  invoicePrefix: z.string().trim().min(1).max(8),
  receiptPrefix: z.string().trim().min(1).max(8),
  ivaRate: z.coerce.number().min(0).max(100),
  fiscalRegime: z.enum(['normal', 'rempe']),
  showIva: z.coerce.boolean(),
  printQrCode: z.coerce.boolean(),
  legalNotes: z.string().trim().max(500).optional().nullable(),
  whatsappTemplate: z.string().trim().max(500).optional().nullable(),
  whatsappTestTemplate: z.string().trim().max(500).optional().nullable(),
  whatsappInvoiceReadyTemplate: z.string().trim().max(700).optional().nullable(),
  whatsappReceiptTemplate: z.string().trim().max(700).optional().nullable(),
  whatsappOverdueTemplate: z.string().trim().max(700).optional().nullable(),
  whatsappSuspensionTemplate: z.string().trim().max(700).optional().nullable(),
  whatsappSuspensionNoticeDays: z.coerce.number().int().min(1).max(120).optional().default(15),
  ultraMsgInstanceId: z.string().trim().max(64).optional().nullable(),
  ultraMsgToken: z.string().trim().max(255).optional().nullable(),
  backupDir: z.string().trim().max(500).optional().nullable()
});

const defaultSettings = {
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
  fiscalRegime: 'normal' as 'normal' | 'rempe',
  showIva: false,
  printQrCode: false,
  legalNotes: '',
  whatsappTemplate: fallbackWhatsappTemplate,
  whatsappTestTemplate: fallbackWhatsappTestTemplate,
  whatsappInvoiceReadyTemplate: fallbackWhatsappInvoiceReadyTemplate,
  whatsappReceiptTemplate: fallbackWhatsappReceiptTemplate,
  whatsappOverdueTemplate: fallbackWhatsappOverdueTemplate,
  whatsappSuspensionTemplate: fallbackWhatsappSuspensionTemplate,
  whatsappSuspensionNoticeDays: 15,
  ultraMsgInstanceId: '',
  ultraMsgToken: '',
  backupDir: ''
};

type SettingKey = keyof typeof defaultSettings;

export async function registerSettingsRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: requireRole(['admin']) };

  app.get('/api/settings', adminOnly, async () => {
    const db = getSqliteDatabase();
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: SettingKey; value: string }>;
    const settings = { ...defaultSettings };

    for (const row of rows) {
      if (row.key === 'defaultDueDay') {
        settings.defaultDueDay = Number(row.value) || defaultSettings.defaultDueDay;
      } else if (row.key === 'ivaRate') {
        const n = Number(row.value);
        settings.ivaRate = Number.isFinite(n) ? n : defaultSettings.ivaRate;
      } else if (row.key === 'whatsappSuspensionNoticeDays') {
        const n = Number(row.value);
        settings.whatsappSuspensionNoticeDays = Number.isFinite(n) ? n : defaultSettings.whatsappSuspensionNoticeDays;
      } else if (row.key === 'fiscalRegime') {
        settings.fiscalRegime = row.value === 'rempe' ? 'rempe' : 'normal';
      } else if (row.key === 'showIva' || row.key === 'printQrCode') {
        settings[row.key] = row.value === 'true' || row.value === '1';
      } else if (row.key in settings) {
        settings[row.key] = row.value as never;
      }
    }

    return settings;
  });

  app.put('/api/settings', adminOnly, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Configuracoes invalidas' });
    }

    const db = getSqliteDatabase();

    const readCurrent = (key: 'invoicePrefix' | 'receiptPrefix'): string => {
      const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
      const raw = row?.value?.trim();
      return raw && raw.length > 0 ? raw : defaultSettings[key];
    };

    const countEmitted = (column: 'invoice_number' | 'receipt_number'): number => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE ${column} IS NOT NULL`).get() as { n: number };
      return row.n;
    };

    const currentInvoicePrefix = readCurrent('invoicePrefix');
    const currentReceiptPrefix = readCurrent('receiptPrefix');

    if (parsed.data.invoicePrefix !== currentInvoicePrefix && countEmitted('invoice_number') > 0) {
      return reply.status(400).send({
        error: 'Prefixo de fatura nao pode ser alterado depois de emitida a primeira fatura'
      });
    }

    if (parsed.data.receiptPrefix !== currentReceiptPrefix && countEmitted('receipt_number') > 0) {
      return reply.status(400).send({
        error: 'Prefixo de recibo nao pode ser alterado depois de emitido o primeiro recibo'
      });
    }

    const wantedBackupDir = (parsed.data.backupDir ?? '').trim();
    if (wantedBackupDir.length > 0) {
      try {
        if (!existsSync(wantedBackupDir) || !statSync(wantedBackupDir).isDirectory()) {
          return reply.status(400).send({ error: 'Pasta de backups inexistente' });
        }
        accessSync(wantedBackupDir, constants.W_OK);
      } catch {
        return reply.status(400).send({ error: 'Pasta de backups sem permissão de escrita' });
      }
    }

    const save = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `);

    const run = db.transaction(() => {
      for (const [key, value] of Object.entries(parsed.data)) {
        save.run(key, String(value ?? ''));
      }
    });

    run();
    recordAudit(request, {
      action: 'update',
      entityType: 'settings',
      summary: 'Atualizou configuracoes',
      metadata: {
        companyName: parsed.data.companyName,
        defaultDueDay: parsed.data.defaultDueDay,
        backupDirChanged: wantedBackupDir.length > 0
      }
    });
    return parsed.data;
  });
}

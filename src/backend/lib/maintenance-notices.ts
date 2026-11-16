import type Database from 'better-sqlite3';
import { clientsDownstreamOf } from './network-incidents';
import { enqueueWhatsapp } from './whatsapp-outbox';
import { enqueueSmsNotification } from './sms-outbox';
import { smsChannelActive } from './sms-notices';
import { normalizeWhatsappPhone, resolveWhatsappProvider, whatsappChannelActive } from './whatsapp-provider';
import { fallbackWhatsappMaintenanceTemplate, renderWhatsappTemplate } from '../../shared/whatsapp';
import { fallbackSmsMaintenanceTemplate, normalizeSmsPhone, renderSmsTemplate } from '../../shared/sms';
import { formatPtDate } from '../../shared/date';
import { toGsm7 } from '../../shared/message-describe';

export const MAINTENANCE_KINDS = ['manutencao', 'calibracao', 'configuracao'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

/** O que se vai fazer, como entra na frase "vamos fazer {motivo}". */
const REASONS: Record<MaintenanceKind, string> = {
  manutencao: 'uma manutenção',
  calibracao: 'a calibração do equipamento',
  configuracao: 'uma mudança de configuração'
};

export type MaintenanceWindow = { kind: MaintenanceKind; day: string; start: string; end: string };

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

/** Os campos da janela primeiro (só este aviso os tem); depois os de sempre, como `{empresa}`. */
function fill(template: string, window: MaintenanceWindow, gsm7: boolean): string {
  const values: Record<string, string> = { data: formatPtDate(window.day), inicio: window.start, fim: window.end, motivo: REASONS[window.kind] };
  return template.replace(/\{(data|inicio|fim|motivo)\}/g, (_token, key: string) => (gsm7 ? toGsm7(values[key]) : values[key]));
}

export function renderMaintenanceBodies(db: Database.Database, window: MaintenanceWindow) {
  const company = getSetting(db, 'companyName') || 'ISPM';
  const empty = { fullName: '', clientCode: '' };
  return {
    whatsapp: renderWhatsappTemplate(fill(getSetting(db, 'whatsappMaintenanceTemplate') || fallbackWhatsappMaintenanceTemplate, window, false), empty, company),
    sms: renderSmsTemplate(fill(getSetting(db, 'smsMaintenanceTemplate') || fallbackSmsMaintenanceTemplate, window, true), { ...empty, clientCode: null }, company)
  };
}

type Recipient = { clientId: number; channel: 'whatsapp' | 'sms'; to: string };

/**
 * A quem chega e por onde: WhatsApp, ou SMS sem ele. Na Meta segue por SMS: fora da janela de
 * 24 h ela só entrega modelos aprovados, e este aviso ainda não tem um.
 */
function plan(db: Database.Database, deviceId: number) {
  const whatsapp = whatsappChannelActive(db) && resolveWhatsappProvider(db)?.id !== 'meta-cloud';
  const sms = smsChannelActive(db);
  const client = db.prepare('SELECT phone, whatsapp_opt_out AS optOut FROM clients WHERE id = ? AND system_kind IS NULL');
  const recipients: Recipient[] = [];
  let skipped = 0;
  const downstream = clientsDownstreamOf(db, deviceId);
  for (const { clientId } of downstream) {
    const row = client.get(clientId) as { phone: string | null; optOut: number } | undefined;
    const channel = whatsapp ? 'whatsapp' : sms ? 'sms' : null;
    const to = channel === 'whatsapp' ? normalizeWhatsappPhone(row?.phone || '') : channel === 'sms' ? normalizeSmsPhone(row?.phone || '') : '';
    if (!row || row.optOut || !channel || !to) { skipped += 1; continue; }
    recipients.push({ clientId, channel, to });
  }
  return { total: downstream.length, recipients, skipped };
}

export type MaintenancePreview = { total: number; whatsapp: number; sms: number; skipped: number };

export function previewMaintenanceNotice(db: Database.Database, deviceId: number): MaintenancePreview {
  const { total, recipients, skipped } = plan(db, deviceId);
  return { total, whatsapp: recipients.filter((r) => r.channel === 'whatsapp').length, sms: recipients.filter((r) => r.channel === 'sms').length, skipped };
}

/** Grava o aviso e põe uma mensagem por cliente a jusante na fila do seu canal. */
export function sendMaintenanceNotice(db: Database.Database, deviceId: number, window: MaintenanceWindow, userId: number | null) {
  const { total, recipients, skipped } = plan(db, deviceId);
  const bodies = renderMaintenanceBodies(db, window);
  const noticeId = db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO maintenance_notices (backbone_device_id, kind, day, starts_at, ends_at, whatsapp_body, sms_body, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(deviceId, window.kind, window.day, window.start, window.end, bodies.whatsapp, bodies.sms, userId).lastInsertRowid);
    const record = db.prepare('INSERT INTO maintenance_notice_recipients (notice_id, client_id, channel, outbox_id) VALUES (?, ?, ?, ?)');
    for (const r of recipients) {
      const outboxId = r.channel === 'whatsapp'
        ? enqueueWhatsapp({ toPhone: r.to, kind: 'text', body: bodies.whatsapp, clientId: r.clientId, origin: 'manual' })
        : enqueueSmsNotification({ clientId: r.clientId, eventType: 'maintenance_notice', toPhone: r.to, body: bodies.sms });
      record.run(id, r.clientId, r.channel, outboxId);
    }
    return id;
  })();
  return { noticeId, total, whatsapp: recipients.filter((r) => r.channel === 'whatsapp').length, sms: recipients.filter((r) => r.channel === 'sms').length, skipped };
}

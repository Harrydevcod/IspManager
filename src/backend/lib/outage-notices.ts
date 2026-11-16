import { getSqliteDatabase } from '../db/database';
import { loadIncidents } from './network-incidents';
import { enqueueWhatsapp } from './whatsapp-outbox';
import { enqueueSmsNotification } from './sms-outbox';
import { outageSmsBody, outageSmsEvent, smsChannelActive } from './sms-notices';
import { normalizeWhatsappPhone, resolveWhatsappProvider, whatsappChannelActive } from './whatsapp-provider';
import { listMetaCloudTemplates } from './meta-cloud';
import { prepareMetaTemplate } from './meta-template';
import { readSecret } from './secrets';
import { fallbackWhatsappOutageTemplate, fallbackWhatsappRestoredTemplate, renderWhatsappTemplate } from '../../shared/whatsapp';
import { normalizeSmsPhone } from '../../shared/sms';
import { outageNoticeSendingAllowed } from '../../shared/business-day';

type Kind = 'outage' | 'restored';

const DEFAULT_DELAY_MINUTES = 10;

export type OutageNoticesRun =
  | { skipped: true; reason: string }
  | { ran: true; outage: number; restored: number; skipped: number; templateErrors?: Array<{ kind: Kind; reason: string }> };

function getSetting(key: string): string {
  const row = getSqliteDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value.trim() || '';
}

/** Minutos que uma queda tem de durar antes de avisar: as micro-quedas não incomodam ninguém. */
function delayMinutes(): number {
  const n = Number(getSetting('outageNoticeDelayMinutes'));
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : DEFAULT_DELAY_MINUTES;
}

/**
 * Aviso proativo de avaria: os clientes a jusante de um equipamento do backbone em baixo há
 * {@link delayMinutes} recebem uma mensagem, e o `reposto` quando a sonda o vê voltar. Só a quem
 * soube da avaria, e uma vez por incidente (chave única em `incident_notices`).
 *
 * WhatsApp primeiro; SMS quando o WhatsApp não está ativo ou, na Meta, não há modelo aprovado
 * escolhido (fora da janela de 24 h a Meta só entrega modelos). Desligado por omissão.
 * Os cortes da antena Starlink ficam de fora: só se conhecem depois de acabarem.
 */
export async function runOutageNoticesIfDue(now: Date = new Date()): Promise<OutageNoticesRun> {
  if (getSetting('outageNoticesEnabled') !== 'true') return { skipped: true, reason: 'avisos de avaria desligados' };
  if (getSetting('networkProbeEnabled') !== 'true') return { skipped: true, reason: 'sonda de rede desligada' };
  const db = getSqliteDatabase();
  const nowSql = now.toISOString().slice(0, 19).replace('T', ' ');
  // Recuperar mensagens ainda em curso mesmo depois de vários dias com o ISPM fechado.
  const oldest = db.prepare(`
    SELECT MIN(substr(n.incident_key, instr(n.incident_key, ':') + 1)) AS at
    FROM incident_notices n
    LEFT JOIN whatsapp_outbox w ON n.channel = 'whatsapp' AND w.id = n.outbox_id
    LEFT JOIN sms_outbox s ON n.channel = 'sms' AND s.id = n.outbox_id
    WHERE n.kind = 'outage'
      AND NOT EXISTS (SELECT 1 FROM incident_notices r WHERE r.incident_key = n.incident_key AND r.client_id = n.client_id AND r.kind = 'restored')
      AND (w.status IN ('pending','sent','delivered','read') OR s.status IN ('pending_dispatch','pending_approval','approved','sent'))
  `).get() as { at: string | null };
  const oldestMs = oldest.at ? Date.parse(`${oldest.at.replace(' ', 'T')}Z`) : NaN;
  const windowDays = Number.isFinite(oldestMs) ? Math.max(1, Math.ceil((now.getTime() - oldestMs) / 86_400_000) + 1) : 1;
  const { incidents } = loadIncidents(db, windowDays, nowSql);
  const pending = db.prepare("SELECT channel, outbox_id AS outboxId FROM incident_notices WHERE incident_key = ? AND kind = 'outage'");
  for (const incident of incidents) {
    if (incident.backboneDeviceId === null || incident.status !== 'resolved') continue;
    for (const row of pending.all(incident.key) as Array<{ channel: string; outboxId: number }>) {
      if (row.channel === 'whatsapp') db.prepare("UPDATE whatsapp_outbox SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(row.outboxId);
      else {
        db.prepare("UPDATE sms_outbox SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending_dispatch' AND android_request_id IS NULL").run(row.outboxId);
        // Pode ter chegado ao telemóvel apesar de a resposta se perder: consultar o estado, sem repetir o POST.
        db.prepare("UPDATE sms_outbox SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ? AND status = 'pending_dispatch' AND android_request_id IS NOT NULL").run(row.outboxId);
      }
    }
  }
  const whatsapp = whatsappChannelActive(db);
  const sms = smsChannelActive(db);
  if (!whatsapp && !sms) return { skipped: true, reason: 'nenhum canal de mensagens ativo' };
  if (!outageNoticeSendingAllowed(now)) return { skipped: true, reason: 'fora das horas de envio' };

  const companyName = getSetting('companyName') || 'ISPM';
  const sources: Record<Kind, string> = {
    outage: getSetting('whatsappOutageTemplate') || fallbackWhatsappOutageTemplate,
    restored: getSetting('whatsappRestoredTemplate') || fallbackWhatsappRestoredTemplate
  };
  const templates: Partial<Record<Kind, { name: string; language: string; body: string }>> = {};
  const templateErrors: Array<{ kind: Kind; reason: string }> = [];
  const meta = whatsapp && resolveWhatsappProvider(db)?.id === 'meta-cloud';
  const selections: Record<Kind, string> = { outage: getSetting('metaTemplateOutage'), restored: getSetting('metaTemplateRestored') };
  if (meta && (selections.outage || selections.restored)) {
    const account = getSetting('metaBusinessAccountId');
    const token = readSecret(db, 'metaAccessToken');
    const listed = /^\d{1,32}$/.test(account) && token ? await listMetaCloudTemplates(account, token) : null;
    for (const kind of ['outage', 'restored'] as const) {
      if (!selections[kind]) continue;
      const approved = listed?.ok ? listed.templates.find((item) => `${item.name}|${item.language}` === selections[kind]) : undefined;
      const prepared = approved ? prepareMetaTemplate(approved, sources[kind], { fullName: '', clientCode: '' }, companyName) : null;
      if (prepared?.ok && approved) templates[kind] = approved;
      else templateErrors.push({ kind, reason: prepared && prepared.ok === false ? prepared.reason : 'Modelo selecionado nao esta aprovado ou nao e suportado' });
    }
  }
  /** Por onde sai cada tipo: na Meta, sem modelo aprovado, o WhatsApp não chega ao cliente. */
  const channelFor = (kind: Kind): 'whatsapp' | 'sms' | null =>
    whatsapp && (!meta || templates[kind]) ? 'whatsapp' : sms ? 'sms' : null;

  const clientRow = db.prepare('SELECT phone, full_name AS fullName, client_code AS clientCode, zone, whatsapp_opt_out AS optOut FROM clients WHERE id = ? AND system_kind IS NULL');
  const notified = db.prepare(`
    SELECT n.client_id AS clientId, n.kind, n.channel, n.outbox_id AS outboxId,
      CASE n.channel WHEN 'whatsapp' THEN w.status ELSE s.status END AS status
    FROM incident_notices n
    LEFT JOIN whatsapp_outbox w ON n.channel = 'whatsapp' AND w.id = n.outbox_id
    LEFT JOIN sms_outbox s ON n.channel = 'sms' AND s.id = n.outbox_id
    WHERE n.incident_key = ?
  `);
  const record = db.prepare(`
    INSERT INTO incident_notices (incident_key, client_id, kind, channel, outbox_id) VALUES (?, ?, ?, ?, ?)
  `);

  const counts = { outage: 0, restored: 0, skipped: 0 };
  const send = (incidentKey: string, clientId: number, kind: Kind, zone: string | null) => {
    const client = clientRow.get(clientId) as { phone: string | null; fullName: string; clientCode: string; zone: string | null; optOut: number } | undefined;
    const channel = channelFor(kind);
    const to = channel === 'sms' ? normalizeSmsPhone(client?.phone || '') : normalizeWhatsappPhone(client?.phone || '');
    if (!client || client.optOut || !channel || !to) { counts.skipped += 1; return; }
    const data = { fullName: client.fullName, clientCode: client.clientCode, phone: client.phone, zone: client.zone || zone };
    const approved = templates[kind];
    const prepared = approved ? prepareMetaTemplate(approved, sources[kind], data, companyName) : null;
    if (prepared && !prepared.ok) { counts.skipped += 1; return; }
    db.transaction(() => {
      const outboxId = channel === 'whatsapp'
        ? enqueueWhatsapp({ toPhone: to, kind: 'text', body: renderWhatsappTemplate(sources[kind], data, companyName), clientId, origin: 'auto', template: prepared?.ok ? prepared.template : undefined })
        : enqueueSmsNotification({ clientId, eventType: outageSmsEvent(kind), toPhone: to, body: outageSmsBody(kind) });
      record.run(incidentKey, clientId, kind, channel, outboxId);
    })();
    counts[kind] += 1;
  };

  // A consulta à Meta é assíncrona: a sonda pode ter registado o regresso entretanto.
  const currentIncidents = meta ? loadIncidents(db, windowDays, nowSql).incidents : incidents;
  for (const incident of currentIncidents) {
    if (incident.backboneDeviceId === null) continue;
    const done = notified.all(incident.key) as Array<{ clientId: number; kind: Kind; channel: 'whatsapp' | 'sms'; outboxId: number; status: string | null }>;
    const has = (clientId: number, kind: Kind) => done.some((row) => row.clientId === clientId && row.kind === kind);
    if (incident.status === 'open' && (incident.durationSeconds ?? 0) >= delayMinutes() * 60) {
      for (const client of incident.clients) if (!has(client.clientId, 'outage')) send(incident.key, client.clientId, 'outage', incident.zone);
    } else if (incident.status === 'resolved') {
      // O reposto vai a quem teve o aviso, mesmo que tenha deixado de pender do equipamento.
      for (const row of done) {
        if (row.kind !== 'outage') continue;
        if (['sent', 'delivered', 'read'].includes(row.status ?? '') && !has(row.clientId, 'restored')) send(incident.key, row.clientId, 'restored', incident.zone);
      }
    }
  }

  return { ran: true, ...counts, ...(templateErrors.length ? { templateErrors } : {}) };
}

import type Database from 'better-sqlite3';

/**
 * O que chegou de facto ao cliente. A verdade é o estado das filas de envio (`sms_outbox`,
 * `whatsapp_outbox`), não o registo de avisos, que grava "enviado" ao enfileirar.
 *
 * Medido na base real a 2026-11-15: de 6 a 13/11 saíram 44 SMS falhados ("fetch failed") e
 * nenhum entregue, o WhatsApp nunca entregou nada (0 de 157), e o corte automático esteve ligado
 * o tempo todo. Daqui saem as duas guardas: o corte espera por um aviso entregue, e um dia de
 * falhas sem nenhuma entrega é alarme.
 */

/** O cliente foi avisado desta dívida? Um SMS enviado ou um WhatsApp aceite, de vencido ou de corte. */
export function noticeDelivered(db: Database.Database, paymentId: number): boolean {
  return db.prepare(`
    SELECT 1 FROM sms_outbox
    WHERE payment_id = ? AND event_type IN ('payment_overdue', 'suspension_notice') AND status = 'sent'
    UNION ALL
    SELECT 1 FROM whatsapp_notices n
    JOIN whatsapp_outbox o ON o.id = n.outbox_id
    WHERE n.payment_id = ? AND n.notice_type IN ('overdue', 'warning', 'suspension')
      AND o.status IN ('sent', 'delivered', 'read')
    LIMIT 1
  `).get(paymentId, paymentId) !== undefined;
}

export type StalledNotices = { failed: number; smsError: string | null };

/**
 * Avisos falhados nas últimas 24 horas sem uma única entrega no mesmo período; `null` quando
 * algum chegou ou nada falhou. Um canal desligado não falha: as falhas antigas dele não contam.
 */
export function stalledNotices(db: Database.Database): StalledNotices | null {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sms_outbox WHERE status = 'failed' AND created_at >= datetime('now', '-24 hours')) AS smsFailed,
      (SELECT COUNT(*) FROM whatsapp_outbox WHERE status = 'failed' AND created_at >= datetime('now', '-24 hours')) AS whatsappFailed,
      (SELECT COUNT(*) FROM sms_outbox WHERE status = 'sent' AND created_at >= datetime('now', '-24 hours'))
        + (SELECT COUNT(*) FROM whatsapp_outbox WHERE status IN ('sent','delivered','read') AND created_at >= datetime('now', '-24 hours')) AS delivered,
      (SELECT last_error FROM sms_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 1) AS smsError,
      (SELECT value FROM app_settings WHERE key = 'smsCompanionEnabled') AS smsEnabled,
      (SELECT value FROM app_settings WHERE key = 'whatsappChannelEnabled') AS whatsappEnabled
  `).get() as { smsFailed: number; whatsappFailed: number; delivered: number; smsError: string | null; smsEnabled: string | null; whatsappEnabled: string | null };
  const smsFailed = row.smsEnabled === 'true' ? row.smsFailed : 0;
  const failed = smsFailed + (row.whatsappEnabled !== 'false' ? row.whatsappFailed : 0);
  if (failed === 0 || row.delivered > 0) return null;
  return { failed, smsError: smsFailed > 0 ? row.smsError : null };
}

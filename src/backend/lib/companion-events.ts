import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordSystemAuditEntry } from './audit';
import { requestCompanionSnapshotPush } from './companion-sync';
import { companionUserId, markNotificationReadByUid, markNotificationsSeen, recordNotification } from './notifications';
import { readSecret } from './secrets';
import { randomUUID } from 'node:crypto';
import { signedFetch } from './sms-outbox';
import { verifyResponseSignature } from './sms-signing';
import { balanceSqlExpr, payPayment } from './payments';
import { updateTicket } from './support-tickets';
import { completeWorkOrder } from './work-orders';

/**
 * Canal de volta da app móvel (0095). O telemóvel guarda o que acontece no
 * terreno numa fila; o desktop puxa-a pelo mesmo HTTP assinado dos SMS, grava
 * cada evento pelo id do telemóvel e só então confirma (`ack`), para o telemóvel
 * apagar. Uma falha a meio volta a trazer os mesmos eventos, que o id torna
 * inofensivos. O telemóvel nunca chama o desktop.
 */

const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 1024 * 1024;

/**
 * GET assinado cuja resposta também vem assinada pelo telemóvel; null quando
 * falha, é grande demais ou a assinatura não bate (outro equipamento no IP).
 */
async function verifiedGet(path: string, maxBytes: number, timeoutMs: number): Promise<{ body: Buffer; type: string | null } | null> {
  const secret = readSecret(getSqliteDatabase(), 'smsCompanionPairingKey');
  if (!secret) return null;
  const nonce = randomUUID();
  const response = await signedFetch(path, 'GET', undefined, timeoutMs, undefined, nonce);
  if (!response.ok) return null;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) return null;
  if (!verifyResponseSignature(secret, nonce, body, response.headers.get('x-ispm-response-signature'))) return null;
  return { body, type: response.headers.get('content-type') };
}

const iso = z.string().min(10).max(40).refine((v) => Number.isFinite(Date.parse(v)), 'data invalida');

const workOrderDone = z.object({
  workOrderId: z.number().int().positive(),
  notes: z.string().trim().min(1).max(2000),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  photos: z.array(z.string().regex(/^[A-Za-z0-9-]{8,64}$/)).max(MAX_PHOTOS).default([])
});

/** Dar um pedido de assistência por resolvido no terreno. Sem fotos: as da OS
 * vivem em `work_order_attachments`, que exige uma OS. */
const ticketDone = z.object({
  ticketId: z.number().int().positive(),
  notes: z.string().trim().min(1).max(2000)
});

const receiptProposal = z.object({
  clientCode: z.string().trim().min(1).max(40),
  amountCve: z.number().positive().max(10_000_000),
  method: z.enum(['numerario', 'transferencia']),
  note: z.string().trim().max(500).optional(),
  /** A caixa ou o banco que o terreno indicou; o operador pode trocá-la ao confirmar. */
  accountId: z.number().int().positive().optional()
});

/** O sino do telemóvel: o que lá nasce, o que lá se lê e quando lá se abriu o painel. */
const notificationNew = z.object({
  uid: z.string().trim().min(1).max(80),
  kind: z.string().trim().max(40),
  severity: z.enum(['info', 'warn', 'danger']),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(500).nullish(),
  tab: z.enum(['painel', 'pedidos', 'historico', 'ajustes']).optional()
});

const notificationRead = z.object({
  uids: z.array(z.string().trim().min(1).max(80)).min(1).max(200)
});

const eventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  kind: z.string().max(40),
  at: iso,
  payload: z.record(z.unknown())
});

export type CompanionEvent = z.infer<typeof eventSchema>;

export type CompanionEventsDeps = {
  fetchEvents: () => Promise<CompanionEvent[] | null>;
  fetchMedia: (id: string) => Promise<Buffer | null>;
  ack: (ids: string[]) => Promise<boolean>;
};

async function defaultFetchEvents(): Promise<CompanionEvent[] | null> {
  try {
    // 404 (app anterior à 0.7.0, sem canal de volta) ou assinatura errada: nada a fazer.
    const verified = await verifiedGet('/events', MAX_EVENTS_BYTES, 5000);
    if (!verified) return null;
    const json = (() => { try { return JSON.parse(verified.body.toString('utf8')) as { events?: unknown }; } catch { return null; } })();
    if (!Array.isArray(json?.events)) return null;
    return json.events.flatMap((e) => {
      const parsed = eventSchema.safeParse(e);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return null;
  }
}

async function defaultFetchMedia(id: string): Promise<Buffer | null> {
  try {
    const verified = await verifiedGet(`/media/${id}`, MAX_PHOTO_BYTES, 15000);
    if (!verified || verified.type !== 'image/jpeg') return null;
    const bytes = verified.body;
    // JPEG começa sempre por FF D8: o que não for foto não entra na base.
    return bytes.length > 0 && bytes.length <= MAX_PHOTO_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : null;
  } catch {
    return null;
  }
}

async function defaultAck(ids: string[]): Promise<boolean> {
  try {
    return (await signedFetch('/events/ack', 'POST', { ids }, 5000)).ok;
  } catch {
    return false;
  }
}

const defaultDeps: CompanionEventsDeps = { fetchEvents: defaultFetchEvents, fetchMedia: defaultFetchMedia, ack: defaultAck };

type Outcome = { status: 'pending' | 'applied' | 'rejected'; reason?: string };

function apply(db: Database.Database, event: CompanionEvent, photos: Buffer[]): Outcome {
  if (event.kind === 'work_order_done') {
    const p = workOrderDone.safeParse(event.payload);
    if (!p.success) return { status: 'rejected', reason: 'dados da OS invalidos' };
    const done = completeWorkOrder(db, p.data.workOrderId, { notes: p.data.notes, completedAt: event.at });
    if (!done.ok) return { status: 'rejected', reason: done.reason };
    const insert = db.prepare(`
      INSERT INTO work_order_attachments (work_order_id, kind, mime, data, lat, lon, taken_at, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const photo of photos) insert.run(p.data.workOrderId, 'photo', 'image/jpeg', photo, null, null, event.at, event.id);
    if (p.data.lat !== undefined && p.data.lon !== undefined) {
      insert.run(p.data.workOrderId, 'location', null, null, p.data.lat, p.data.lon, event.at, event.id);
    }
    recordSystemAuditEntry(db, {
      action: 'work_order.completed_on_phone', entityType: 'work_order', entityId: p.data.workOrderId,
      summary: 'OS concluida no telemovel', metadata: { eventId: event.id, photos: photos.length }
    });
    return { status: 'applied' };
  }
  if (event.kind === 'ticket_done') {
    const p = ticketDone.safeParse(event.payload);
    if (!p.success) return { status: 'rejected', reason: 'dados do pedido invalidos' };
    // Um evento pode ficar dias na fila do telemóvel (fora da rede) e chegar
    // depois de alguém já ter tratado o pedido no PC. Só se resolve o que ainda
    // está por resolver — como a OS, que também recusa estar já concluída.
    const open = db.prepare(`
      SELECT 1 FROM support_tickets WHERE id = ? AND status IN ('aberto', 'em_curso', 'aguarda_cliente')
    `).get(p.data.ticketId);
    if (!open) {
      const exists = db.prepare('SELECT 1 FROM support_tickets WHERE id = ?').get(p.data.ticketId);
      return { status: 'rejected', reason: exists ? 'Pedido já não estava aberto' : 'Pedido não encontrado' };
    }
    // `updateTicket` já exige a nota para resolver, grava a mudança de estado no
    // histórico do pedido e acerta o `resolved_at`. Sem utilizador: o autor é o
    // terreno, e o texto da nota di-lo.
    const done = updateTicket(db, p.data.ticketId, {
      status: 'resolvido',
      note: `Resolvido no terreno (app móvel) — ${p.data.notes}`
    }, null);
    if (!done.ok) return { status: 'rejected', reason: done.error };
    recordSystemAuditEntry(db, {
      action: 'support_ticket.resolved_on_phone', entityType: 'support_ticket', entityId: p.data.ticketId,
      summary: 'Pedido resolvido no telemovel', metadata: { eventId: event.id }
    });
    return { status: 'applied' };
  }
  if (event.kind === 'receipt_proposal') {
    const p = receiptProposal.safeParse(event.payload);
    if (!p.success) return { status: 'rejected', reason: 'dados do recebimento invalidos' };
    const client = db.prepare('SELECT id FROM clients WHERE client_code = ?').get(p.data.clientCode);
    // Fica à espera do operador: nenhum escudo entra na caixa sem confirmação no desktop.
    return client ? { status: 'pending' } : { status: 'rejected', reason: 'cliente inexistente' };
  }
  if (event.kind === 'notification_new') {
    const p = notificationNew.safeParse(event.payload);
    if (!p.success) return { status: 'rejected', reason: 'notificacao invalida' };
    // O `uid` do telemóvel é a chave: o mesmo evento repetido não duplica a entrada.
    recordNotification(db, {
      uid: p.data.uid,
      origin: 'phone',
      kind: p.data.kind,
      severity: p.data.severity,
      title: p.data.title,
      detail: p.data.detail ?? null,
      section: p.data.tab === 'historico' ? 'settings' : null,
      focus: p.data.tab === 'historico' ? 'sms' : null,
      createdAt: event.at.replace('T', ' ').slice(0, 19)
    });
    return { status: 'applied' };
  }
  if (event.kind === 'notification_read') {
    const p = notificationRead.safeParse(event.payload);
    if (!p.success) return { status: 'rejected', reason: 'leitura invalida' };
    const userId = companionUserId(db);
    // Sem utilizador para representar não há onde gravar a leitura; o evento fica aceite na mesma.
    if (userId) for (const uid of p.data.uids) markNotificationReadByUid(db, userId, uid, event.at.replace('T', ' ').slice(0, 19));
    return { status: 'applied' };
  }
  if (event.kind === 'notification_seen') {
    const userId = companionUserId(db);
    if (userId) markNotificationsSeen(db, userId, event.at.replace('T', ' ').slice(0, 19));
    return { status: 'applied' };
  }
  return { status: 'rejected', reason: `tipo desconhecido: ${event.kind}` };
}

/** Grava e aplica um evento numa transação. Já visto (mesmo id) = nada a fazer. */
export function storeCompanionEvent(db: Database.Database, event: CompanionEvent, photos: Buffer[] = []): 'stored' | 'duplicate' {
  return db.transaction(() => {
    const known = db.prepare('SELECT 1 FROM companion_events WHERE id = ?').get(event.id);
    if (known) return 'duplicate' as const;
    db.prepare(`
      INSERT INTO companion_events (id, kind, occurred_at, payload_json, status) VALUES (?, ?, ?, ?, 'pending')
    `).run(event.id, event.kind, event.at, JSON.stringify(event.payload));
    const outcome = apply(db, event, photos);
    db.prepare(`
      UPDATE companion_events
      SET status = ?, reason = ?, decided_by = CASE WHEN ? = 'pending' THEN NULL ELSE 'sistema' END,
          decided_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END
      WHERE id = ?
    `).run(outcome.status, outcome.reason ?? null, outcome.status, outcome.status, event.id);
    return 'stored' as const;
  })();
}

export type PullResult = { skipped: true } | { pulled: number; acked: boolean };

/** Um tick: puxa, grava, confirma. Fotos que não chegam deixam o evento para o tick seguinte. */
export async function pullCompanionEventsIfDue(deps: CompanionEventsDeps = defaultDeps): Promise<PullResult> {
  const db = getSqliteDatabase();
  const setting = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  if (setting('smsCompanionEnabled') !== 'true' || !setting('smsCompanionBaseUrl') || !readSecret(db, 'smsCompanionPairingKey')) {
    return { skipped: true };
  }
  const events = await deps.fetchEvents();
  if (!events?.length) return { pulled: 0, acked: false };

  const done: string[] = [];
  let changedWork = false;
  for (const event of events) {
    let photos: Buffer[] = [];
    if (event.kind === 'work_order_done') {
      const ids = workOrderDone.safeParse(event.payload).data?.photos ?? [];
      const fetched = await Promise.all(ids.map((id) => deps.fetchMedia(id)));
      if (fetched.some((b) => b === null)) continue;
      photos = fetched as Buffer[];
    }
    const isWork = event.kind === 'work_order_done' || event.kind === 'ticket_done';
    if (storeCompanionEvent(db, event, photos) === 'stored' && isWork) changedWork = true;
    done.push(event.id);
  }
  // A OS concluída, ou o pedido resolvido, sai já da lista do telemóvel.
  if (changedWork) requestCompanionSnapshotPush();
  const acked = done.length ? await deps.ack(done) : false;
  return { pulled: done.length, acked };
}

export type ReceiptProposal = {
  id: string;
  occurredAt: string;
  clientId: number;
  clientCode: string;
  clientName: string;
  amountCve: number;
  method: 'numerario' | 'transferencia';
  note: string | null;
  /** A conta indicada no terreno, se foi; o PC mostra-a escolhida e pode trocá-la. */
  accountId: number | null;
  /** A fatura que o recibo vai pagar (a em aberto mais antiga); null = sem nada a pagar. */
  target: { paymentId: number; dueDate: string; balanceCve: number } | null;
};

function oldestOpenInvoice(db: Database.Database, clientId: number): ReceiptProposal['target'] {
  const row = db.prepare(`
    SELECT p.id AS paymentId, p.due_date AS dueDate, ${balanceSqlExpr('p')} AS balanceCve
    FROM payments p
    WHERE p.client_id = ? AND p.status != 'cancelled' AND p.document_type = 'invoice' AND ${balanceSqlExpr('p')} > 0.004
    ORDER BY p.due_date, p.id LIMIT 1
  `).get(clientId) as ReceiptProposal['target'] | undefined;
  return row ?? null;
}

/** Recebimentos em mão à espera de confirmação, do mais antigo ao mais recente. */
export function listReceiptProposals(db: Database.Database = getSqliteDatabase()): ReceiptProposal[] {
  const rows = db.prepare(`
    SELECT e.id, e.occurred_at AS occurredAt, e.payload_json AS payloadJson, c.id AS clientId, c.full_name AS clientName
    FROM companion_events e
    JOIN clients c ON c.client_code = json_extract(e.payload_json, '$.clientCode')
    WHERE e.kind = 'receipt_proposal' AND e.status = 'pending'
    ORDER BY e.occurred_at
  `).all() as Array<{ id: string; occurredAt: string; payloadJson: string; clientId: number; clientName: string }>;
  return rows.flatMap((r) => {
    const p = receiptProposal.safeParse(JSON.parse(r.payloadJson));
    if (!p.success) return [];
    return [{
      id: r.id, occurredAt: r.occurredAt, clientId: r.clientId, clientCode: p.data.clientCode, clientName: r.clientName,
      amountCve: p.data.amountCve, method: p.data.method, note: p.data.note ?? null,
      accountId: p.data.accountId ?? null, target: oldestOpenInvoice(db, r.clientId)
    }];
  });
}

export type DecisionResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Confirmar: vira recibo na fatura em aberto mais antiga, com a data do terreno.
 * O excedente fica como crédito do cliente (regra do payPayment). Tudo numa
 * transação: o evento só fica "applied" se o recibo existir.
 */
export function confirmReceiptProposal(
  db: Database.Database, id: string, user: { id: number | null; username: string }, accountId?: number | null
): DecisionResult {
  const proposal = listReceiptProposals(db).find((r) => r.id === id);
  if (!proposal) return { ok: false, status: 404, error: 'Proposta inexistente ou já decidida' };
  if (!proposal.target) return { ok: false, status: 409, error: 'O cliente não tem faturas em aberto' };
  const target = proposal.target;
  return db.transaction((): DecisionResult => {
    const paid = payPayment(db, target.paymentId, {
      paymentMethod: proposal.method,
      paymentDate: proposal.occurredAt.slice(0, 10),
      amountCve: proposal.amountCve,
      // O operador decide; sem escolha dele vale a conta indicada no terreno.
      accountId: accountId ?? proposal.accountId,
      notes: ['Recebido no terreno (app móvel)', proposal.note].filter(Boolean).join(' — '),
      userId: user.id
    });
    if (!paid.ok) return { ok: false, status: paid.status, error: paid.error };
    db.prepare(`UPDATE companion_events SET status = 'applied', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(user.username, id);
    // O cliente sai já da lista de devedores do telemóvel.
    requestCompanionSnapshotPush();
    return { ok: true };
  })();
}

export function rejectReceiptProposal(db: Database.Database, id: string, user: { username: string }, reason: string | null): DecisionResult {
  const changed = db.prepare(`
    UPDATE companion_events SET status = 'rejected', reason = ?, decided_by = ?, decided_at = datetime('now')
    WHERE id = ? AND kind = 'receipt_proposal' AND status = 'pending'
  `).run(reason, user.username, id).changes;
  return changed ? { ok: true } : { ok: false, status: 404, error: 'Proposta inexistente ou já decidida' };
}

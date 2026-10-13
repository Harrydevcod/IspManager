import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { centavosToEscudos, escudosToCentavos } from '../../shared/money';
import { validatePaymentDates } from '../../shared/payment-dates';
import { MANUAL_INVOICE_PREFIX } from '../../shared/billing-period';
import { todayIso } from './billing';
import { allocateDocumentNumber } from './numbering';
import { receiveSaleTicketWithinTx, type PaymentOpResult } from './payments';
import { resolveReceiptAccount, reverseReceiptMovements } from './treasury';

export const saleTicketSchema = z.object({
  requestKey: z.string().uuid(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(200).optional(),
    catalogId: z.number().int().positive().optional(),
    quantity: z.number().int().positive().max(1000000),
    unitPriceCve: z.number().finite().min(0.01),
    serialNumbers: z.array(z.string().trim().min(1).max(120)).max(1000).optional()
  }).strict()).min(1).max(20),
  paymentMethod: z.enum(['numerario', 'transferencia', 'outro']),
  accountId: z.number().int().positive().nullable().optional(),
  issuedOn: z.string().date().refine((value) => Number(value.slice(0, 4)) > 0, 'Ano de emissão inválido').optional(),
  notes: z.string().trim().max(500).optional()
}).strict();

export type SaleTicketInput = z.infer<typeof saleTicketSchema>;
type SaleResult = { paymentId: number; documentNumber: string; amountCve: number };
export type SaleTicketLine = { description: string; quantity: number; unitPriceCve: number; totalCve: number; catalogId: number | null; serialNumbers: string[] };
export type SaleTicket = SaleResult & {
  clientName: string; status: 'paid' | 'cancelled'; paymentMethod: string; accountId: number;
  issuedOn: string; notes: string | null; cancellationReason: string | null; lines: SaleTicketLine[];
};
type Catalog = { id: number; model: string; brand: string | null; isSerialized: number; stockTotal: number; active: number; unitCostCve: number };
class SaleError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export function loadSaleTicket(db: Database, paymentId: number): SaleTicket | null {
  const ticket = db.prepare(`SELECT p.id AS paymentId,p.invoice_number AS documentNumber,p.amount_cve AS amountCve,
    p.status,p.payment_method AS paymentMethod,p.invoice_date AS issuedOn,p.notes,p.cancellation_reason AS cancellationReason,
    c.full_name AS clientName,(SELECT account_id FROM payment_receipts WHERE payment_id=p.id ORDER BY id LIMIT 1) AS accountId
    FROM payments p JOIN clients c ON c.id=p.client_id WHERE p.id=? AND p.document_type='sale_ticket'`).get(paymentId) as Omit<SaleTicket, 'lines'> | undefined;
  if (!ticket) return null;
  const rows = db.prepare(`SELECT l.id,l.description,l.amount_cve AS totalCve,s.quantity,s.unit_price_cve AS unitPriceCve,s.catalog_id AS catalogId
    FROM payment_lines l JOIN sale_ticket_lines s ON s.payment_line_id=l.id WHERE l.payment_id=? ORDER BY l.sort_order,l.id`).all(paymentId) as Array<Omit<SaleTicketLine, 'serialNumbers'> & { id: number }>;
  const serials = db.prepare('SELECT serial_number AS serialNumber FROM sale_ticket_serials WHERE payment_line_id=? ORDER BY id');
  return { ...ticket, lines: rows.map(({ id, ...line }) => ({ ...line, serialNumbers: (serials.all(id) as Array<{ serialNumber: string }>).map((row) => row.serialNumber) })) };
}

/** One synchronous transaction commits the document, stock and money together. */
export function createSaleTicket(db: Database, raw: unknown, userId: number | null): PaymentOpResult<SaleResult> {
  const parsed = saleTicketSchema.safeParse(raw);
  if (!parsed.success) return fail(400, 'Dados do talão inválidos: ' + parsed.error.issues[0].message);
  const input = parsed.data;
  const { requestKey, ...payload } = input;
  const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  try {
    const value = db.transaction((): SaleResult => {
      // Read before catalog validation: replay must still work if prices or availability changed.
      const prior = db.prepare(`SELECT id AS paymentId,invoice_number AS documentNumber,amount_cve AS amountCve,sale_request_hash AS hash
        FROM payments WHERE sale_request_key=?`).get(requestKey) as SaleResult & { hash: string } | undefined;
      if (prior) {
        if (prior.hash !== requestHash) throw new SaleError(409, 'Esta chave de emissão já foi usada com dados diferentes.');
        return { paymentId: prior.paymentId, documentNumber: prior.documentNumber, amountCve: prior.amountCve };
      }
      const issuedOn = input.issuedOn || todayIso();
      const dates = validatePaymentDates({ dataEmissao: issuedOn, dataPagamento: issuedOn }, { emissaoFutureToleranceDays: 0 });
      if (dates.errors.length) throw new SaleError(400, dates.errors.join(' '));
      const destination = resolveReceiptAccount(db, input.paymentMethod, input.accountId);
      if (!destination.ok) throw new SaleError(destination.status, destination.error);
      if (issuedOn < destination.value.openingDate) throw new SaleError(400, 'A data de emissão não pode anteceder a abertura da conta de destino.');
      if (db.prepare("SELECT 1 FROM app_settings WHERE key IN ('invoicePrefix','receiptPrefix') AND upper(trim(value))='TV'").get()) {
        throw new SaleError(409, 'TV é reservado aos Talões de Venda. Altere o prefixo da fatura ou recibo nas Configurações antes de emitir.');
      }
      const client = db.prepare("SELECT id FROM clients WHERE system_kind='indifferentiated' AND status='active'").get() as { id: number } | undefined;
      if (!client) throw new SaleError(409, 'Cliente Indiferenciado indisponível. Reinicie ou restaure a configuração do sistema.');
      const catalogQuery = db.prepare(`SELECT id,brand,model,is_serialized AS isSerialized,stock_total AS stockTotal,active,
        purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve AS unitCostCve FROM equipment_catalog WHERE id=?`);
      const requestedStock = new Map<number, number>();
      const usedSerials = new Set<string>();
      let totalCentavos = 0;
      const lines = input.lines.map((line) => {
        const unitCentavos = escudosToCentavos(line.unitPriceCve);
        const total = unitCentavos * line.quantity;
        if (!Number.isSafeInteger(unitCentavos) || unitCentavos <= 0 || !Number.isSafeInteger(total) || !Number.isSafeInteger(totalCentavos + total)) {
          throw new SaleError(400, 'Os valores do talão devem ser positivos e representáveis em centavos.');
        }
        totalCentavos += total;
        const catalog = line.catalogId ? catalogQuery.get(line.catalogId) as Catalog | undefined : undefined;
        if (line.catalogId && (!catalog || !catalog.active)) throw new SaleError(409, 'Produto indisponível no catálogo.');
        const description = line.description || (catalog ? [catalog.brand, catalog.model].filter(Boolean).join(' ') : '');
        if (!description) throw new SaleError(400, 'Uma linha livre exige descrição.');
        const serialNumbers = line.serialNumbers || [];
        if (catalog?.isSerialized) {
          if (serialNumbers.length !== line.quantity) throw new SaleError(400, 'Indique um número de série por unidade serializada.');
          for (const serial of serialNumbers) {
            const normalized = serial.trim().toUpperCase();
            if (usedSerials.has(normalized)) throw new SaleError(409, 'Número de série repetido no talão.');
            usedSerials.add(normalized);
            const sold = db.prepare('SELECT 1 FROM sale_ticket_serials WHERE normalized_serial=? AND released_at IS NULL').get(normalized);
            const installed = db.prepare('SELECT 1 FROM service_device_assignments WHERE upper(trim(serial_number))=? AND end_date IS NULL').get(normalized);
            const backbone = db.prepare("SELECT 1 FROM backbone_devices WHERE upper(trim(serial_number))=? AND status!='retired'").get(normalized);
            if (sold || installed || backbone) throw new SaleError(409, `Serial ${serial} já vendido ou pertencente a um equipamento em uso.`);
          }
        } else if (serialNumbers.length) throw new SaleError(400, 'Só produtos serializados podem indicar números de série.');
        if (catalog) {
          const quantity = (requestedStock.get(catalog.id) || 0) + line.quantity;
          if (quantity > catalog.stockTotal) throw new SaleError(409, `Stock insuficiente para ${catalog.model}. Disponível: ${catalog.stockTotal}.`);
          requestedStock.set(catalog.id, quantity);
        }
        return { ...line, description, catalog, serialNumbers, unitPriceCve: centavosToEscudos(unitCentavos), totalCve: centavosToEscudos(total) };
      });
      const amountCve = centavosToEscudos(totalCentavos);
      const documentNumber = allocateDocumentNumber('sale_ticket', db, Number(issuedOn.slice(0, 4)));
      const paymentId = Number(db.prepare(`INSERT INTO payments(client_id,reference_month,amount_cve,due_date,status,invoice_number,invoice_date,
        notes,document_type,sale_request_key,sale_request_hash) VALUES (?,?,?,?,'pending',?,?,?,'sale_ticket',?,?)`)
        .run(client.id, `${MANUAL_INVOICE_PREFIX}NOVA`, amountCve, issuedOn, documentNumber, issuedOn, input.notes || null, requestKey, requestHash).lastInsertRowid);
      db.prepare('UPDATE payments SET reference_month=? WHERE id=?').run(`${MANUAL_INVOICE_PREFIX}${paymentId}`, paymentId);
      for (const [index, line] of lines.entries()) {
        const lineId = Number(db.prepare("INSERT INTO payment_lines(payment_id,kind,description,amount_cve,sort_order) VALUES (?,'avulso',?,?,?)")
          .run(paymentId, line.description, line.totalCve, index).lastInsertRowid);
        db.prepare('INSERT INTO sale_ticket_lines(payment_line_id,catalog_id,quantity,unit_price_cve) VALUES (?,?,?,?)')
          .run(lineId, line.catalog?.id ?? null, line.quantity, line.unitPriceCve);
        if (line.catalog) {
          const moved = db.prepare("UPDATE equipment_catalog SET stock_total=stock_total-?,updated_at=datetime('now') WHERE id=? AND stock_total>=?")
            .run(line.quantity, line.catalog.id, line.quantity);
          if (!moved.changes) throw new SaleError(409, 'Stock alterado durante a venda. Atualize os produtos.');
          db.prepare(`INSERT INTO stock_movements(catalog_id,type,quantity,unit_cost_cve,reference,client_name,created_by,sale_ticket_line_id)
            VALUES (?,'saida',?,?,?,'Cliente Indiferenciado',?,?)`).run(line.catalog.id, line.quantity, line.catalog.unitCostCve, documentNumber, userId, lineId);
          for (const serial of line.serialNumbers) db.prepare('INSERT INTO sale_ticket_serials(payment_line_id,serial_number,normalized_serial) VALUES (?,?,?)')
            .run(lineId, serial.trim(), serial.trim().toUpperCase());
        }
      }
      const received = receiveSaleTicketWithinTx(db, paymentId, { paymentMethod: input.paymentMethod, paymentDate: issuedOn, accountId: destination.value.id, userId });
      if (!received.ok) throw new SaleError(received.status, received.error);
      return { paymentId, documentNumber, amountCve };
    }).immediate();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof SaleError) return fail(error.status, error.message);
    throw error;
  }
}

export function cancelSaleTicket(db: Database, paymentId: number, rawReason: string, productsReturned: boolean, userId: number | null): PaymentOpResult<SaleResult> {
  const reason = rawReason.trim();
  if (reason.length < 10 || reason.length > 500) return fail(400, 'A anulação exige um motivo entre 10 e 500 caracteres.');
  if (!productsReturned) return fail(400, 'Confirme a devolução de todos os produtos antes de anular.');
  return db.transaction((): PaymentOpResult<SaleResult> => {
    const ticket = loadSaleTicket(db, paymentId);
    if (!ticket) return fail(404, 'Talão de Venda não encontrado.');
    const value = { paymentId, documentNumber: ticket.documentNumber, amountCve: ticket.amountCve };
    if (ticket.status === 'cancelled') return { ok: true, value };
    if (ticket.status !== 'paid') return fail(409, 'O talão não está integralmente pago. Requer revisão.');
    const receipts = db.prepare('SELECT id FROM payment_receipts WHERE payment_id=? AND voided_at IS NULL').all(paymentId) as Array<{ id: number }>;
    if (receipts.length !== 1) return fail(409, 'O recebimento do talão exige revisão antes de anular.');
    reverseReceiptMovements(db, receipts[0].id, `Talão ${ticket.documentNumber} anulado: ${reason}`, userId);
    db.prepare("UPDATE payment_receipts SET voided_at=datetime('now'),void_reason=? WHERE id=?").run(reason, receipts[0].id);
    const stock = db.prepare(`SELECT s.payment_line_id AS lineId,s.catalog_id AS catalogId,s.quantity,m.unit_cost_cve AS unitCostCve
      FROM sale_ticket_lines s JOIN payment_lines l ON l.id=s.payment_line_id JOIN stock_movements m ON m.sale_ticket_line_id=s.payment_line_id AND m.type='saida'
      WHERE l.payment_id=?`).all(paymentId) as Array<{ lineId: number; catalogId: number; quantity: number; unitCostCve: number }>;
    for (const line of stock) {
      db.prepare("UPDATE equipment_catalog SET stock_total=stock_total+?,updated_at=datetime('now') WHERE id=?").run(line.quantity, line.catalogId);
      db.prepare(`INSERT INTO stock_movements(catalog_id,type,quantity,unit_cost_cve,reference,client_name,created_by,sale_ticket_line_id)
        VALUES (?,'devolucao',?,?,?,'Cliente Indiferenciado',?,?)`).run(line.catalogId, line.quantity, line.unitCostCve, ticket.documentNumber, userId, line.lineId);
    }
    db.prepare("UPDATE sale_ticket_serials SET released_at=datetime('now') WHERE payment_line_id IN (SELECT id FROM payment_lines WHERE payment_id=?) AND released_at IS NULL").run(paymentId);
    db.prepare("UPDATE payments SET status='cancelled',cancellation_reason=?,updated_at=datetime('now') WHERE id=?").run(reason, paymentId);
    return { ok: true, value };
  }).immediate();
}

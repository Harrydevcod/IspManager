/**
 * Fatura manual: passada à mão, fora da geração mensal.
 *
 * Serve o que não é mensalidade — uma deslocação, um cabo, um router vendido —
 * e pode ir para quem ainda não é cliente: o destinatário é registado no mesmo
 * passo, sem serviço. O cliente é sempre obrigatório (é ele que dá nome ao
 * PDF, ao recibo e ao crédito); o serviço é opcional.
 *
 * Quando pertence a um serviço é uma dívida como as outras e conta para o
 * corte automático (ADR 0010). Sem serviço não há o que cortar.
 *
 * Nasce numerada: é um documento desde o primeiro segundo, por isso anula-se,
 * não se apaga nem se edita.
 */

import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { MANUAL_INVOICE_PREFIX } from '../../shared/billing-period';
import { centavosToEscudos, escudosToCentavos } from '../../shared/money';
import { validatePaymentDates } from '../../shared/payment-dates';
import { dueDateFromIssue, todayIso } from './billing';
import { allocateDocumentNumber } from './numbering';
import { applyClientCreditToPayment } from './payments';
import { insertClient } from './client-records';
import { isSystemClient, SYSTEM_CLIENT_ERROR } from './system-client';

const isoDate = z.string().date();

export const manualInvoiceSchema = z.object({
  clientId: z.coerce.number().int().positive().optional().nullable(),
  // Quem ainda não existe: fica registado como cliente, sem serviço.
  newClient: z.object({
    fullName: z.string().trim().min(1).max(160),
    nif: z.string().trim().regex(/^[12]\d{8}$/).optional().nullable().or(z.literal('').transform(() => null)),
    phone: z.string().trim().max(40).optional().nullable(),
    address: z.string().trim().max(240).optional().nullable()
  }).optional().nullable(),
  serviceId: z.coerce.number().int().positive().optional().nullable(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(200),
    amountCve: z.coerce.number().finite().min(0.01)
  })).min(1).max(20),
  invoiceDate: isoDate.optional().nullable(),
  dueDate: isoDate.optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable()
});

export type ManualInvoiceInput = z.infer<typeof manualInvoiceSchema>;

export type ManualInvoiceResult = {
  paymentId: number;
  clientId: number;
  /** Verdadeiro quando o destinatário foi registado por esta fatura. */
  clientCreated: boolean;
  invoiceNumber: string;
  amountCve: number;
  dueDate: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export function createManualInvoice(db: Database, input: ManualInvoiceInput, userId: number | null): Result<ManualInvoiceResult> {
  const newClient = input.newClient ?? null;
  if (Boolean(input.clientId) === Boolean(newClient)) {
    return { ok: false, status: 400, error: 'Indique um cliente existente ou os dados de um destinatario novo' };
  }
  if (newClient && input.serviceId) {
    return { ok: false, status: 400, error: 'Um destinatario novo ainda nao tem servico' };
  }

  if (input.clientId && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(input.clientId)) {
    return { ok: false, status: 404, error: 'Cliente nao encontrado' };
  }
  if (input.clientId && isSystemClient(db, input.clientId)) {
    return { ok: false, status: 409, error: SYSTEM_CLIENT_ERROR };
  }
  if (newClient) {
    // NIF e telefone são únicos na ficha: quem já existe escolhe-se, não se duplica.
    const phone = newClient.phone?.trim() || null;
    const twin = db.prepare(`
      SELECT full_name AS name, client_code AS code FROM clients
      WHERE (? IS NOT NULL AND nif = ?) OR (? IS NOT NULL AND phone = ?)
      LIMIT 1
    `).get(newClient.nif ?? null, newClient.nif ?? null, phone, phone) as { name: string; code: string } | undefined;
    if (twin) {
      return { ok: false, status: 409, error: `Ja existe o cliente ${twin.name} (${twin.code}) com este NIF ou telefone. Escolha-o na lista.` };
    }
  }

  if (input.serviceId) {
    const service = db.prepare('SELECT client_id AS clientId, status FROM services WHERE id = ?')
      .get(input.serviceId) as { clientId: number; status: string } | undefined;
    if (!service || service.clientId !== input.clientId) {
      return { ok: false, status: 400, error: 'O servico nao pertence a este cliente' };
    }
    if (service.status === 'cancelled') {
      return { ok: false, status: 400, error: 'Servico cancelado: passe a fatura sem servico' };
    }
  }

  const invoiceDate = input.invoiceDate || todayIso();
  const dueDate = input.dueDate || dueDateFromIssue(invoiceDate);
  const { errors } = validatePaymentDates(
    { dataEmissao: invoiceDate, dataVencimento: dueDate },
    { emissaoFutureToleranceDays: 0 }
  );
  if (errors.length) return { ok: false, status: 400, error: errors.join(' ') };
  if (dueDate < invoiceDate) return { ok: false, status: 400, error: 'O vencimento nao pode ser anterior a emissao' };

  const lineCentavos = input.lines.map((line) => escudosToCentavos(line.amountCve));
  const totalCentavos = lineCentavos.reduce((sum, amount) => sum + amount, 0);
  if (lineCentavos.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)
    || !Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) {
    return { ok: false, status: 400, error: 'Os valores da fatura devem ser positivos e representaveis em centavos' };
  }
  const amountCve = centavosToEscudos(totalCentavos);

  const value = db.transaction((): ManualInvoiceResult => {
    const clientId = newClient
      ? insertClient(db, newClient)
      : input.clientId!;

    // A chave de competência leva o id da própria fatura, por isso entra com
    // uma provisória e acerta-se logo a seguir, dentro da mesma transação.
    const paymentId = Number(db.prepare(`
      INSERT INTO payments (
        client_id, service_id, reference_month, amount_cve, due_date,
        status, invoice_date, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))
    `).run(clientId, input.serviceId ?? null, `${MANUAL_INVOICE_PREFIX}NOVA`, amountCve, dueDate, invoiceDate, input.notes || null).lastInsertRowid);

    const invoiceNumber = allocateDocumentNumber('invoice');
    db.prepare('UPDATE payments SET reference_month = ?, invoice_number = ? WHERE id = ?')
      .run(`${MANUAL_INVOICE_PREFIX}${paymentId}`, invoiceNumber, paymentId);

    const insertLine = db.prepare(`
      INSERT INTO payment_lines (payment_id, kind, description, amount_cve, sort_order)
      VALUES (?, 'avulso', ?, ?, ?)
    `);
    input.lines.forEach((line, index) => insertLine.run(paymentId, line.description, centavosToEscudos(lineCentavos[index]), index));

    // Crédito que o cliente já tenha abate aqui, como na geração mensal.
    applyClientCreditToPayment(db, paymentId, userId);

    return { paymentId, clientId, clientCreated: Boolean(newClient), invoiceNumber, amountCve, dueDate };
  })();

  return { ok: true, value };
}

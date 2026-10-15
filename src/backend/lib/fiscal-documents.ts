import { z } from "zod";
import { getSqliteDatabase } from "../db/database";
import type {
  FiscalDocument,
  FiscalDocumentList,
} from "../../shared/fiscal-documents";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  });
export const fiscalQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(250).optional(),
    clientId: z.coerce.number().int().positive().optional(),
    paymentId: z.coerce.number().int().positive().optional(),
    documentType: z.enum(["invoice", "receipt", "sale_ticket"]).optional(),
    status: z
      .enum(["pending", "overdue", "paid", "issued", "cancelled"])
      .optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to);
// This is a read projection: consulting documents never allocates numbers.
export function listFiscalDocuments(
  query: z.infer<typeof fiscalQuerySchema>,
): FiscalDocumentList {
  const db = getSqliteDatabase();
  const source = `WITH archive AS (
    SELECT 'payment' source, p.id sourceId, p.id paymentId, p.document_type documentType, p.invoice_number number,
      COALESCE(p.invoice_date,p.created_at) date, p.client_id clientId, c.full_name clientName,
      p.amount_cve amountCve, CASE WHEN p.status='pending' AND p.due_date < date('now','localtime') THEN 'overdue' ELSE p.status END status
      FROM payments p JOIN clients c ON c.id=p.client_id WHERE p.invoice_number IS NOT NULL AND trim(p.invoice_number)<>'' AND upper(trim(p.invoice_number))<>'PENDING'
    UNION ALL
    SELECT 'receipt', r.id, p.id, 'receipt', r.receipt_number, r.receipt_date, p.client_id, c.full_name,
      r.amount_cve, CASE WHEN r.voided_at IS NOT NULL OR p.status='cancelled' THEN 'cancelled' ELSE 'issued' END
      FROM payment_receipts r JOIN payments p ON p.id=r.payment_id JOIN clients c ON c.id=p.client_id
      WHERE p.document_type='invoice' AND trim(r.receipt_number)<>'' AND upper(trim(r.receipt_number))<>'PENDING'
    UNION ALL
    SELECT 'payment', p.id, p.id, 'receipt', p.receipt_number, COALESCE(p.receipt_date,p.payment_date,p.created_at), p.client_id, c.full_name,
      p.amount_cve, CASE WHEN p.status='cancelled' THEN 'cancelled' ELSE 'issued' END
      FROM payments p JOIN clients c ON c.id=p.client_id
      WHERE p.document_type='invoice' AND p.receipt_number IS NOT NULL AND trim(p.receipt_number)<>'' AND upper(trim(p.receipt_number))<>'PENDING'
      AND NOT EXISTS (SELECT 1 FROM payment_receipts r WHERE r.payment_id=p.id)
  )`;
  const where: string[] = [];
  const values: (string | number)[] = [];
  for (const field of [
    "clientId",
    "paymentId",
    "documentType",
    "status",
  ] as const)
    if (query[field] !== undefined) {
      where.push(`${field}=?`);
      values.push(query[field]!);
    }
  if (query.search) {
    where.push("(number LIKE ? ESCAPE '\\' OR clientName LIKE ? ESCAPE '\\')");
    const search = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
    values.push(search, search);
  }
  if (query.from) {
    where.push("substr(date,1,10)>=?");
    values.push(query.from);
  }
  if (query.to) {
    where.push("substr(date,1,10)<=?");
    values.push(query.to);
  }
  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (
    db
      .prepare(`${source} SELECT COUNT(*) total FROM archive${filter}`)
      .get(...values) as { total: number }
  ).total;
  const items = db
    .prepare(
      `${source} SELECT * FROM archive${filter} ORDER BY date DESC, documentType ASC, source ASC, sourceId DESC LIMIT ? OFFSET ?`,
    )
    .all(
      ...values,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ) as FiscalDocument[];
  return { items, total, page: query.page, pageSize: query.pageSize };
}

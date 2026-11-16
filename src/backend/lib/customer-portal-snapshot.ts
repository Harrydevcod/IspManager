import type Database from 'better-sqlite3';
import { balanceSqlExpr, clientCreditBalance } from './payments';
import { escudosToCentavos } from '../../shared/money';

/** Only the information needed by the customer, captured at a clearly stated instant. */
export function buildCustomerPortalSnapshot(db: Database.Database, clientId: number, now: Date) {
  const customer = db.prepare('SELECT full_name AS name, client_code AS code FROM clients WHERE id = ? AND system_kind IS NULL')
    .get(clientId) as { name: string; code: string } | undefined;
  if (!customer) throw new Error('Cliente não encontrado');
  const invoices = db.prepare(`SELECT p.invoice_number AS number, p.due_date AS dueDate, ${balanceSqlExpr('p')} AS balance
    FROM payments p WHERE p.client_id = ? AND p.document_type = 'invoice' AND p.status IN ('pending', 'overdue')
    AND ${balanceSqlExpr('p')} > 0 ORDER BY p.due_date, p.id`).all(clientId) as Array<{ number: string | null; dueDate: string; balance: number }>;
  const services = db.prepare(`SELECT COALESCE(p.name, '') AS plan, s.status FROM services s
    LEFT JOIN internet_plans p ON p.id = s.plan_id WHERE s.client_id = ? AND s.status <> 'cancelled' ORDER BY s.id`)
    .all(clientId) as Array<{ plan: string; status: string }>;
  return { customerName: customer.name, customerCode: customer.code, generatedAt: now.toISOString(),
    creditCents: escudosToCentavos(clientCreditBalance(db, clientId)),
    invoices: invoices.map(({ number, dueDate, balance }) => ({ number, dueDate, balanceCents: escudosToCentavos(balance) })), services };
}

import type Database from 'better-sqlite3';
import { balanceSqlExpr, clientCreditBalance } from './payments';
import { escudosToCentavos } from '../../shared/money';
import { describePayments } from './payment-description';
import { documentBankAccounts } from './treasury';

/** As mesmas chaves que a fatura em PDF usa para o emitente (documents.ts, loadCompany). */
const COMPANY_KEYS = ['companyName', 'nif', 'address', 'island', 'phone', 'email'] as const;

/** Only the information needed by the customer, captured at a clearly stated instant. */
export function buildCustomerPortalSnapshot(db: Database.Database, clientId: number, now: Date) {
  const customer = db.prepare(`SELECT full_name AS name, client_code AS code, COALESCE(nif, '') AS nif,
    COALESCE(address, '') AS address, COALESCE(island, '') AS island FROM clients WHERE id = ? AND system_kind IS NULL`)
    .get(clientId) as { name: string; code: string; nif: string; address: string; island: string } | undefined;
  if (!customer) throw new Error('Cliente não encontrado');
  const invoices = db.prepare(`SELECT p.id, p.invoice_number AS number, p.due_date AS dueDate, ${balanceSqlExpr('p')} AS balance
    FROM payments p WHERE p.client_id = ? AND p.document_type = 'invoice' AND p.status IN ('pending', 'overdue')
    AND ${balanceSqlExpr('p')} > 0 ORDER BY p.due_date, p.id`).all(clientId) as Array<{ id: number; number: string | null; dueDate: string; balance: number }>;
  // O que cada fatura cobra e a que período diz respeito, como nas mensagens.
  const described = describePayments(db, invoices.map((invoice) => invoice.id));
  const services = db.prepare(`SELECT COALESCE(p.name, '') AS plan, s.status FROM services s
    LEFT JOIN internet_plans p ON p.id = s.plan_id WHERE s.client_id = ? AND s.status <> 'cancelled' ORDER BY s.id`)
    .all(clientId) as Array<{ plan: string; status: string }>;
  const settings = new Map((db.prepare(`SELECT key, value FROM app_settings WHERE key IN (${COMPANY_KEYS.map(() => '?').join(',')})`)
    .all(...COMPANY_KEYS) as Array<{ key: string; value: string }>).map((row) => [row.key, row.value ?? '']));
  const company = { name: settings.get('companyName') ?? '', nif: settings.get('nif') ?? '', address: settings.get('address') ?? '',
    island: settings.get('island') ?? '', phone: settings.get('phone') ?? '', email: settings.get('email') ?? '' };
  // As contas para transferência só aparecem a quem tem algo para liquidar.
  const bankAccounts = invoices.length === 0 ? [] : documentBankAccounts(db)
    .map((account) => ({ bank: account.bankName, holder: account.accountName, account: account.accountNumber, reference: account.reference }));
  return { company, customerName: customer.name, customerCode: customer.code,
    customerNif: customer.nif, customerAddress: [customer.address, customer.island].filter(Boolean).join(' · '),
    generatedAt: now.toISOString(),
    creditCents: escudosToCentavos(clientCreditBalance(db, clientId)),
    invoices: invoices.map(({ id, number, dueDate, balance }) => ({
      number, dueDate, balanceCents: escudosToCentavos(balance),
      services: described.get(id)?.services ?? '', period: described.get(id)?.period ?? ''
    })), services, bankAccounts };
}

import type { Database } from 'better-sqlite3';
import { SQL_BUSINESS_TODAY, businessDay } from '../../shared/business-day';
import {
  PAYMENT_CLASS_LETTERS, PUNCTUALITY_SCALE_CODES, SCORE_WINDOW_MONTHS,
  monthsBefore, punctualityScaleOf, scoreClient, trendFor,
  type FinancialState, type InvoiceFact, type PaymentClass, type PaymentScore,
  type PaymentTrend, type PunctualityScale
} from '../../shared/payment-score';
import { balanceSqlExpr, overdueSqlPredicate } from './payments';

/**
 * Read model do comportamento de pagamento: a letra de cada cliente e o que a
 * sustenta.
 *
 * Sem cache, como a cobrança e o painel da Operação — em SQLite local são
 * milissegundos, e um valor de há cinco minutos numa conversa de cobrança é
 * pior do que valor nenhum.
 *
 * O SQL aqui só traz factos: que mensalidades venceram e que dinheiro entrou
 * por elas. A pontuação calcula-se em `shared/payment-score.ts`, que é puro e
 * testável — cinco linhas de SQL a decidir uma fórmula de quatro critérios
 * seria código que ninguém consegue verificar.
 */

/** Dois anos de factos: a janela da pontuação é de 12 meses, a tendência precisa de passado. */
const FACT_WINDOW_MONTHS = SCORE_WINDOW_MONTHS * 2;

export type ClientBehaviour = PaymentScore & {
  clientId: number;
  clientName: string;
  clientCode: string;
  zone: string | null;
  clientStatus: string;
  state: FinancialState;
  overdueCve: number;
  trend: PaymentTrend;
};

/** A chave em `app_settings`; a escolha vive em Configurações › Faturação. */
export const PUNCTUALITY_SCALE_KEY = 'punctualityScale';

/**
 * A escala em vigor. Como em quinze outros módulos deste repo, a leitura de
 * `app_settings` é local — um valor por ler ou estragado cai na de omissão, que
 * é o que mantém a carteira classificada mesmo numa instalação acabada de abrir.
 */
export function currentPunctualityScale(db: Database): PunctualityScale {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(PUNCTUALITY_SCALE_KEY) as { value: string } | undefined;
  return punctualityScaleOf(row?.value.trim());
}

export type PaymentBehaviourReport = {
  generatedAt: string;
  asOf: string;
  /** A escala com que estas letras foram calculadas. */
  scale: PunctualityScale;
  totals: {
    /** Clientes com classificação consolidada (histórico bastante). */
    classified: number;
    /** Clientes ainda sem histórico para uma letra. */
    provisional: number;
    avgScore: number;
    /** Percentagem de clientes classificados que estão em dia hoje. */
    inGoodStandingPct: number;
    distribution: Record<PaymentClass, number>;
  };
  clients: ClientBehaviour[];
};

const money = (value: unknown): number => Math.round((Number(value) || 0) * 100) / 100;

type InvoiceRow = { paymentId: number; clientId: number; dueDate: string; amountCve: number };
type ReceiptRow = { paymentId: number; date: string; amountCve: number };
type ClientRow = {
  clientId: number; clientName: string; clientCode: string; zone: string | null;
  clientStatus: string; suspended: number; overdueCve: number;
};

/**
 * As mensalidades que se julgam: só faturas de competência mensal.
 *
 * Talões de venda são venda à vista, e `INSTALACAO` e `AVULSA-<id>` não são
 * mensalidades — contá-los desalinhava a contagem por mês de quem só tem um
 * serviço. Anuladas ficam de fora porque um erro nosso não pode prejudicar
 * ninguém, e o que ainda não venceu não se julga.
 */
function loadFacts(db: Database, since: string, clientId?: number) {
  const clientFilter = clientId === undefined ? '' : 'AND p.client_id = ?';
  const args = clientId === undefined ? [since] : [since, clientId];

  const invoices = db.prepare(`
    SELECT p.id AS paymentId, p.client_id AS clientId, p.due_date AS dueDate, p.amount_cve AS amountCve
    FROM payments p
    JOIN clients c ON c.id = p.client_id
    WHERE c.system_kind IS NULL
      AND p.status <> 'cancelled'
      AND COALESCE(p.document_type, 'invoice') = 'invoice'
      AND p.reference_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
      AND date(p.due_date) <= ${SQL_BUSINESS_TODAY}
      AND p.due_date >= ?
      ${clientFilter}
    ORDER BY p.due_date
  `).all(...args) as InvoiceRow[];

  const receipts = db.prepare(`
    SELECT r.payment_id AS paymentId, r.payment_date AS date, r.amount_cve AS amountCve
    FROM payment_receipts r
    JOIN payments p ON p.id = r.payment_id
    WHERE r.voided_at IS NULL
      AND p.status <> 'cancelled'
      AND p.due_date >= ?
      ${clientFilter}
    ORDER BY r.payment_date
  `).all(...args) as ReceiptRow[];

  // Qualquer `source`: liquidar por conta corrente é liquidar — o dinheiro
  // entrou quando o crédito nasceu, e a obrigação do mês ficou cumprida.
  const byInvoice = new Map<number, InvoiceFact>();
  const byClient = new Map<number, InvoiceFact[]>();
  for (const row of invoices) {
    const fact: InvoiceFact = { dueDate: row.dueDate, amountCve: money(row.amountCve), receipts: [] };
    byInvoice.set(row.paymentId, fact);
    const list = byClient.get(row.clientId);
    if (list) list.push(fact);
    else byClient.set(row.clientId, [fact]);
  }
  for (const row of receipts) {
    byInvoice.get(row.paymentId)?.receipts.push({ date: row.date, amountCve: money(row.amountCve) });
  }
  return byClient;
}

function loadClients(db: Database, clientId?: number): ClientRow[] {
  return db.prepare(`
    SELECT
      c.id AS clientId,
      c.full_name AS clientName,
      c.client_code AS clientCode,
      c.zone,
      c.status AS clientStatus,
      EXISTS (SELECT 1 FROM services s WHERE s.client_id = c.id AND s.status = 'suspended') AS suspended,
      COALESCE((
        SELECT SUM(${balanceSqlExpr('p')}) FROM payments p
        WHERE p.client_id = c.id AND p.status <> 'cancelled'
          AND ${overdueSqlPredicate('p')} AND ${balanceSqlExpr('p')} > 0.005
      ), 0) AS overdueCve
    FROM clients c
    WHERE c.system_kind IS NULL ${clientId === undefined ? '' : 'AND c.id = ?'}
    ORDER BY c.full_name
  `).all(...(clientId === undefined ? [] : [clientId])) as ClientRow[];
}

function stateOf(row: ClientRow): FinancialState {
  if (row.suspended) return 'suspenso';
  return row.overdueCve > 0.005 ? 'vencido' : 'em_dia';
}

/** `clientId` restringe a um cliente (ficha financeira); sem ele, a carteira toda. */
export function loadPaymentBehaviour(
  db: Database,
  options: { asOf?: string; clientId?: number; scale?: PunctualityScale } = {}
): PaymentBehaviourReport {
  const asOf = options.asOf ?? businessDay();
  const scale = options.scale ?? currentPunctualityScale(db);
  const since = monthsBefore(asOf, FACT_WINDOW_MONTHS);
  const facts = loadFacts(db, since, options.clientId);

  const clients: ClientBehaviour[] = loadClients(db, options.clientId).map((row) => {
    const invoices = facts.get(row.clientId) ?? [];
    return {
      ...scoreClient(invoices, asOf, scale),
      clientId: row.clientId,
      clientName: row.clientName,
      clientCode: row.clientCode,
      zone: row.zone,
      clientStatus: row.clientStatus,
      state: stateOf(row),
      overdueCve: money(row.overdueCve),
      trend: trendFor(invoices, asOf, scale)
    };
  });

  const classified = clients.filter((client) => client.letter !== null);
  const distribution = Object.fromEntries(
    PAYMENT_CLASS_LETTERS.map((letter) => [letter, classified.filter((c) => c.letter === letter).length])
  ) as Record<PaymentClass, number>;

  return {
    generatedAt: new Date().toISOString(),
    asOf,
    scale,
    totals: {
      classified: classified.length,
      provisional: clients.length - classified.length,
      // A média é dos classificados: incluir quem ainda não tem histórico
      // puxava a carteira para baixo com zeros que não são dívida de ninguém.
      avgScore: classified.length
        ? Math.round(classified.reduce((sum, c) => sum + c.score, 0) / classified.length)
        : 0,
      inGoodStandingPct: classified.length
        ? Math.round((classified.filter((c) => c.state === 'em_dia').length / classified.length) * 100)
        : 0,
      distribution
    },
    clients
  };
}

/** A classificação de um cliente só, para a ficha financeira. */
export function behaviourForClient(db: Database, clientId: number, asOf?: string): ClientBehaviour | null {
  return loadPaymentBehaviour(db, { asOf, clientId }).clients[0] ?? null;
}

export type ScaleDistribution = {
  scale: PunctualityScale;
  classified: number;
  distribution: Record<PaymentClass, number>;
};

/**
 * O que cada escala faria à carteira de hoje, para a escolha nas Configurações
 * se fazer sobre números e não sobre adjectivos: "generosa" e "exigente" são
 * duas palavras que ninguém consegue avaliar sozinhas.
 *
 * Os factos lêem-se uma vez e dobram-se três — na carteira real são duas
 * centenas de linhas, e a política deste read model é não ter cache.
 */
export function punctualityScaleDistributions(db: Database, asOf?: string): ScaleDistribution[] {
  const at = asOf ?? businessDay();
  const facts = loadFacts(db, monthsBefore(at, FACT_WINDOW_MONTHS));
  const clients = loadClients(db).map((row) => facts.get(row.clientId) ?? []);

  return PUNCTUALITY_SCALE_CODES.map((scale) => {
    const letters = clients.map((invoices) => scoreClient(invoices, at, scale).letter);
    const classified = letters.filter((letter) => letter !== null);
    return {
      scale,
      classified: classified.length,
      distribution: Object.fromEntries(
        PAYMENT_CLASS_LETTERS.map((letter) => [letter, classified.filter((l) => l === letter).length])
      ) as Record<PaymentClass, number>
    };
  });
}

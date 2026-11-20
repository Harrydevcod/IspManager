import type { Database } from 'better-sqlite3';
import { businessDay } from '../../shared/business-day';
import {
  PAYMENT_CLASS_LETTERS, PUNCTUALITY_SCALE_CODES, SCORE_WINDOW_MONTHS,
  delayLimitOf, monthsBefore, punctualityScaleOf, scoreClient, trendFor,
  type FinancialState, type InvoiceFact, type PaymentClass, type PaymentScore,
  type PaymentTrend, type PunctualityScale, type ScoreRules
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

/** As chaves em `app_settings`; as escolhas vivem em Configurações › Faturação. */
export const PUNCTUALITY_SCALE_KEY = 'punctualityScale';
export const DELAY_LIMIT_KEY = 'punctualityDelayLimitDays';

/**
 * As regras em vigor. Como em quinze outros módulos deste repo, a leitura de
 * `app_settings` é local — um valor por ler ou estragado cai na omissão, que é
 * o que mantém a carteira classificada mesmo numa instalação acabada de abrir.
 */
export function currentScoreRules(db: Database): ScoreRules {
  const read = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const scale = read.get(PUNCTUALITY_SCALE_KEY) as { value: string } | undefined;
  const limit = read.get(DELAY_LIMIT_KEY) as { value: string } | undefined;
  return {
    scale: punctualityScaleOf(scale?.value.trim()),
    delayLimitDays: delayLimitOf(limit?.value.trim())
  };
}

export type PaymentBehaviourReport = {
  generatedAt: string;
  asOf: string;
  /** As regras com que estas letras foram calculadas. */
  rules: ScoreRules;
  totals: {
    /** Clientes com letra — basta uma mensalidade avaliável. */
    classified: number;
    /** Clientes sem nada para julgar: aguardam a primeira avaliação. */
    awaiting: number;
    avgScore: number;
    /** Percentagem de clientes classificados que estão em dia hoje. */
    inGoodStandingPct: number;
    /** Percentagem dos classificados que nunca pagaram uma mensalidade tarde. */
    alwaysOnTimePct: number;
    improving: number;
    declining: number;
    distribution: Record<PaymentClass, number>;
    /** Dívida vencida de hoje, por categoria: onde é que o risco tem dinheiro. */
    overdueByClass: Record<PaymentClass, number>;
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
 * ninguém.
 *
 * O que ainda não venceu não se corta aqui: quem decide é `outcomeFor`, que tem
 * os recibos à mão e sabe distinguir a que ainda não venceu nem foi paga — que
 * não se julga — da que foi paga adiantada, que já conta. A regra fica num
 * sítio só, em vez de meia em SQL e meia em TypeScript.
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
  options: { asOf?: string; clientId?: number; rules?: ScoreRules } = {}
): PaymentBehaviourReport {
  const asOf = options.asOf ?? businessDay();
  const rules = options.rules ?? currentScoreRules(db);
  const since = monthsBefore(asOf, FACT_WINDOW_MONTHS);
  const facts = loadFacts(db, since, options.clientId);

  const clients: ClientBehaviour[] = loadClients(db, options.clientId).map((row) => {
    const invoices = facts.get(row.clientId) ?? [];
    return {
      ...scoreClient(invoices, asOf, rules),
      clientId: row.clientId,
      clientName: row.clientName,
      clientCode: row.clientCode,
      zone: row.zone,
      clientStatus: row.clientStatus,
      state: stateOf(row),
      overdueCve: money(row.overdueCve),
      trend: trendFor(invoices, asOf, rules)
    };
  });

  const classified = clients.filter((client) => client.letter !== null);
  const share = (count: number) => (classified.length ? Math.round((count / classified.length) * 100) : 0);
  const byClass = <T>(pick: (rows: ClientBehaviour[]) => T) => Object.fromEntries(
    PAYMENT_CLASS_LETTERS.map((letter) => [letter, pick(classified.filter((c) => c.letter === letter))])
  ) as Record<PaymentClass, T>;

  return {
    generatedAt: new Date().toISOString(),
    asOf,
    rules,
    totals: {
      classified: classified.length,
      awaiting: clients.length - classified.length,
      // A média é dos classificados: incluir quem não tem nada para julgar
      // puxava a carteira para baixo com zeros que não são dívida de ninguém.
      avgScore: classified.length
        ? Math.round(classified.reduce((sum, c) => sum + c.score, 0) / classified.length)
        : 0,
      inGoodStandingPct: share(classified.filter((c) => c.state === 'em_dia').length),
      alwaysOnTimePct: share(classified.filter((c) => c.punctualityPct === 100).length),
      improving: classified.filter((c) => c.trend === 'up').length,
      declining: classified.filter((c) => c.trend === 'down').length,
      distribution: byClass((rows) => rows.length),
      overdueByClass: byClass((rows) => money(rows.reduce((sum, c) => sum + c.overdueCve, 0)))
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
  // O limite de atraso em vigor entra na comparação: o que se está a escolher
  // aqui é a escala, e as duas colunas têm de variar uma de cada vez.
  const { delayLimitDays } = currentScoreRules(db);
  const facts = loadFacts(db, monthsBefore(at, FACT_WINDOW_MONTHS));
  const clients = loadClients(db).map((row) => facts.get(row.clientId) ?? []);

  return PUNCTUALITY_SCALE_CODES.map((scale) => {
    const letters = clients.map((invoices) => scoreClient(invoices, at, { scale, delayLimitDays }).letter);
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

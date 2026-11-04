/**
 * Vinti4 (SISP) como via principal de pagamento online, por EasyLink (ADR 0019).
 *
 * O ISPM não fala com o SISP: o pagamento web do Vinti4 devolve o resultado
 * por POST a um endereço público do comerciante, e o ISPM corre num PC sem
 * endereço público. O operador cria o EasyLink no Portal do Comerciante, cola-o
 * na fatura, e o ISPM leva-o nos avisos. O recibo regista-se à mão, pela porta
 * de sempre (`payPayment`), quando o portal mostra o link como pago.
 */

import type Database from 'better-sqlite3';
import { escudosToCentavos, isSettled, roundEscudos } from '../../shared/money';
import { balanceSqlExpr } from './payments';
import { openStripeLinkSql } from './stripe-payments';
import { getAccount } from './treasury';
import { isSystemClient, SYSTEM_CLIENT_ERROR } from './system-client';

// Domínios do SISP. O EasyLink tem a forma
// https://www.vinti4.cv/easylink.aspx?id=…&token=… (documentação do SISP).
const SISP_DOMAINS = ['vinti4.cv', 'vinti4net.cv', 'sisp.cv'];

export type Vinti4Config = { enabled: boolean; accountId: number | null; ready: boolean };

export type Vinti4Link = {
  url: string;
  amountCve: number;
  /** O valor do link ainda é o saldo: só assim segue nos avisos. */
  current: boolean;
};

export type Vinti4Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

export function readVinti4Config(db: Database.Database): Vinti4Config {
  const enabled = setting(db, 'vinti4Enabled') === 'true';
  const accountId = Number(setting(db, 'vinti4TreasuryAccountId')) || null;
  const account = accountId ? getAccount(db, accountId) : undefined;
  return { enabled, accountId, ready: enabled && Boolean(account?.active) };
}

/**
 * O URL vai para os clientes: só um link HTTPS de um domínio do SISP. Um link
 * de outro sítio colado por engano (ou de phishing) não pode sair num aviso.
 */
export function parseEasyLinkUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  // A raiz de um site (ex.: o próprio Portal do Comerciante) não é um link de
  // pagamento: o cliente caía no login do comerciante.
  if ((url.pathname === '/' || url.pathname === '') && !url.search) return null;
  const host = url.hostname.toLowerCase();
  return SISP_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? url.toString() : null;
}

/**
 * O link a pôr num aviso, em SQL: o EasyLink cujo valor ainda é o saldo e,
 * na falta dele, o link Stripe aberto. O Vinti4 vem primeiro por ser a via
 * principal. Só lê a base.
 */
export function openPaymentLinkSql(alias: string): string {
  return `COALESCE(CASE WHEN ${alias}.vinti4_link_url IS NOT NULL AND ${alias}.status != 'cancelled'`
    + ` AND EXISTS (SELECT 1 FROM app_settings WHERE key = 'vinti4Enabled' AND value = 'true')`
    + ` AND ABS(${alias}.vinti4_link_amount_cve - ${balanceSqlExpr(alias)}) < 0.005`
    + ` THEN ${alias}.vinti4_link_url END, ${openStripeLinkSql(alias)})`;
}

type LinkRow = { url: string | null; amountCve: number | null; balanceCve: number; status: string };

function loadRow(db: Database.Database, paymentId: number): LinkRow | undefined {
  return db.prepare(`
    SELECT vinti4_link_url AS url, vinti4_link_amount_cve AS amountCve, status,
           ${balanceSqlExpr('payments')} AS balanceCve
    FROM payments WHERE id = ?
  `).get(paymentId) as LinkRow | undefined;
}

/** O EasyLink da fatura, para a ficha dela. */
export function vinti4LinkFor(db: Database.Database, paymentId: number): Vinti4Link | null {
  const row = loadRow(db, paymentId);
  if (!row?.url || row.amountCve === null) return null;
  return {
    url: row.url,
    amountCve: row.amountCve,
    current: row.status !== 'cancelled' && escudosToCentavos(row.amountCve) === escudosToCentavos(roundEscudos(row.balanceCve))
  };
}

/** Guarda o EasyLink colado, pelo saldo atual: é esse o valor que o link deve cobrar. */
export function setVinti4Link(db: Database.Database, paymentId: number, rawUrl: string): Vinti4Result<Vinti4Link> {
  if (!readVinti4Config(db).ready) return { ok: false, status: 409, error: 'Vinti4 por configurar: ative-o e escolha a conta de destino nas Configurações' };
  const head = db.prepare('SELECT client_id AS clientId, document_type AS documentType FROM payments WHERE id = ?')
    .get(paymentId) as { clientId: number; documentType: string } | undefined;
  const row = loadRow(db, paymentId);
  if (!head || !row) return { ok: false, status: 404, error: 'Pagamento nao encontrado' };
  if (isSystemClient(db, head.clientId)) return { ok: false, status: 409, error: SYSTEM_CLIENT_ERROR };
  if (head.documentType === 'sale_ticket') return { ok: false, status: 409, error: 'Taloes de venda nao admitem link de pagamento' };
  const balance = roundEscudos(row.balanceCve);
  if (row.status === 'cancelled' || isSettled(balance)) return { ok: false, status: 409, error: 'Esta fatura já não tem nada a cobrar' };
  const url = parseEasyLinkUrl(rawUrl);
  if (!url) return { ok: false, status: 400, error: 'Cole um link EasyLink do Vinti4 (https, domínio vinti4.cv ou sisp.cv)' };

  db.prepare(`UPDATE payments SET vinti4_link_url = ?, vinti4_link_amount_cve = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(url, balance, paymentId);
  return { ok: true, value: { url, amountCve: balance, current: true } };
}

export function clearVinti4Link(db: Database.Database, paymentId: number): boolean {
  return db.prepare(`UPDATE payments SET vinti4_link_url = NULL, vinti4_link_amount_cve = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(paymentId).changes === 1;
}

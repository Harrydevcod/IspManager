import type { Database } from 'better-sqlite3';
import { z } from 'zod';

/** Tabelas com código de artigo. Lista fechada: o nome entra no SQL. */
type CodedTable = 'articles' | 'equipment_catalog' | 'internet_plans';
export type ArticleKind = 'product' | 'service';

export const ARTICLE_PREFIX: Record<ArticleKind, string> = { product: 'ART', service: 'SRV' };

/** Vazio = o servidor propõe um. Letras, números, ponto, hífen e sublinhado. */
export const codeField = z.string().trim().max(20).regex(/^[A-Za-z0-9._-]*$/, 'use letras, números, ponto ou hífen').optional().nullable();

export function codeTaken(db: Database, table: CodedTable, code: string, exceptId?: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE code = ? COLLATE NOCASE AND id <> ?`).get(code, exceptId ?? 0));
}

/** Próximo código livre do prefixo (ART0001, EQP0001…), como o `nextClientCode`. */
export function nextCode(db: Database, table: CodedTable, prefix: string): string {
  // Conta só os do mesmo prefixo: o primeiro serviço é SRV0001 mesmo havendo produtos.
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE code LIKE ? || '%'`).get(prefix) as { total: number };
  for (let n = total + 1; ; n += 1) {
    const code = `${prefix}${String(n).padStart(4, '0')}`;
    if (!codeTaken(db, table, code)) return code;
  }
}

/** A chave de comparação de nomes: sem maiúsculas nem espaços a mais (o NOCASE do SQLite só conhece ASCII). */
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt');

/**
 * A linha livre de um documento passa a ser um artigo: reutiliza o ativo com o mesmo nome
 * ou cria um com código novo. Corre dentro da transação de quem emite o documento.
 */
export function resolveFreeLineArticle(db: Database, description: string, unitPriceCve: number, kind: ArticleKind): number {
  const key = nameKey(description);
  const actives = db.prepare('SELECT id, name FROM articles WHERE active = 1').all() as Array<{ id: number; name: string }>;
  const existing = actives.find((row) => nameKey(row.name) === key);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO articles(code, name, kind, unit_price_cve) VALUES (?, ?, ?, ?)')
    .run(nextCode(db, 'articles', ARTICLE_PREFIX[kind]), description.trim().replace(/\s+/g, ' '), kind, unitPriceCve).lastInsertRowid);
}

/** Artigo ativo escolhido no documento; null se não existir ou estiver desativado. */
export function activeArticle(db: Database, id: number): { id: number; name: string } | null {
  return (db.prepare('SELECT id, name FROM articles WHERE id = ? AND active = 1').get(id) as { id: number; name: string } | undefined) ?? null;
}

export type LineRef = { code: string | null; note: string | null };
const NO_REF: LineRef = { code: null, note: null };

/** Código e nota a gravar na linha do documento, lidos no momento da emissão. Os planos não têm nota. */
export function lineRef(db: Database, table: CodedTable, id: number | null | undefined): LineRef {
  if (!id) return NO_REF;
  const note = table === 'internet_plans' ? 'NULL' : 'document_note';
  return (db.prepare(`SELECT code, ${note} AS note FROM ${table} WHERE id = ?`).get(id) as LineRef | undefined) ?? NO_REF;
}

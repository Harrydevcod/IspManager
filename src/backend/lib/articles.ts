import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { escudosToCentavos } from '../../shared/money';

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
  // Parte do maior número do mesmo prefixo: com ART0100 escrito à mão, o seguinte é ART0101.
  // O primeiro serviço é SRV0001 mesmo havendo produtos. Sufixos não numéricos contam 0.
  const { top } = db.prepare(`SELECT COALESCE(MAX(CAST(substr(code, length(?) + 1) AS INTEGER)), 0) AS top
    FROM ${table} WHERE code LIKE ? || '%'`).get(prefix, prefix) as { top: number };
  for (let n = top + 1; ; n += 1) {
    const code = `${prefix}${String(n).padStart(4, '0')}`;
    if (!codeTaken(db, table, code)) return code;
  }
}

/** A chave de comparação de nomes: sem maiúsculas nem espaços a mais (o NOCASE do SQLite só conhece ASCII). */
const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt');

/**
 * A linha livre de um documento passa a ser um artigo: reutiliza o ativo com o mesmo nome e tipo
 * ou cria um com código novo. O preço da linha manda no documento; o do artigo não muda.
 * Corre dentro da transação de quem emite o documento.
 */
export function resolveFreeLineArticle(db: Database, description: string, unitPriceCve: number, kind: ArticleKind): number {
  const key = nameKey(description);
  const actives = db.prepare('SELECT id, name, kind FROM articles WHERE active = 1').all() as Array<{ id: number; name: string; kind: ArticleKind }>;
  const existing = actives.find((row) => nameKey(row.name) === key && row.kind === kind);
  if (existing) return existing.id;
  // ponytail: o mesmo nome noutro tipo leva sufixo, porque o nome é único entre ativos.
  const name = description.trim().replace(/\s+/g, ' ');
  const taken = actives.some((row) => nameKey(row.name) === key);
  const finalName = taken ? `${name} (${kind === 'product' ? 'produto' : 'serviço'})`.slice(0, 200) : name;
  const clash = actives.find((row) => nameKey(row.name) === nameKey(finalName));
  if (clash) return clash.id;
  return Number(db.prepare('INSERT INTO articles(code, name, kind, unit_price_centavos) VALUES (?, ?, ?, ?)')
    .run(nextCode(db, 'articles', ARTICLE_PREFIX[kind]), finalName, kind, escudosToCentavos(unitPriceCve)).lastInsertRowid);
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

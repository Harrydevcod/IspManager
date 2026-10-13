import type { Database } from 'better-sqlite3';

/** A identidade de sistema e reservada a vendas sem destinatario identificado. */
export function isSystemClient(db: Database, clientId: number): boolean {
  const row = db.prepare('SELECT system_kind AS systemKind FROM clients WHERE id = ?')
    .get(clientId) as { systemKind: string | null } | undefined;
  return row?.systemKind != null;
}

export const SYSTEM_CLIENT_ERROR = 'Cliente Indiferenciado reservado a taloes de venda';

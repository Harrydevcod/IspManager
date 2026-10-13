import type { Database } from 'better-sqlite3';
import type { clients } from '../db/schema';

type ClientInput = Pick<typeof clients.$inferInsert,
  'fullName' | 'phone' | 'nif' | 'island' | 'zone' | 'address' | 'status'>;

/** Código disponível, incluindo bases em que houve clientes apagados. */
function nextClientCode(db: Database): string {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM clients').get() as { total: number };
  const taken = db.prepare('SELECT 1 FROM clients WHERE client_code = ?');
  for (let n = total + 1; ; n += 1) {
    const code = `C${String(n).padStart(4, '0')}`;
    if (!taken.get(code)) return code;
  }
}

/** Cadastro local usado tanto pela ficha de cliente como pela fatura manual. */
export function insertClient(db: Database, data: ClientInput): number {
  return db.transaction(() => {
    const now = new Date().toISOString();
    return Number(db.prepare(`
      INSERT INTO clients (client_code, full_name, phone, nif, island, zone, address, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nextClientCode(db), data.fullName, data.phone || null, data.nif || null,
      data.island || null, data.zone || null, data.address || null, data.status ?? 'active', now, now).lastInsertRowid);
  })();
}

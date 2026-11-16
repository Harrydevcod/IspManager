import type Database from 'better-sqlite3';
import { createPortalSecret, derivePortalLink, encryptPortalSnapshot } from './customer-portal-crypto';
import { buildCustomerPortalSnapshot } from './customer-portal-snapshot';
import { normalizeRelayUrl } from './sms-relay';

/** A mesma regra do relé SMS (HTTPS; HTTP só num Worker local em ensaio), e sem caminho. */
function originFor(raw: string): string {
  const normalized = normalizeRelayUrl(raw);
  if (!normalized || new URL(normalized).pathname !== '/') throw new Error('Endereço do relé inválido');
  return new URL(normalized).origin;
}

export async function issueCustomerPortal(db: Database.Database, clientId: number, relay: string, adminKey: string, now = new Date()) {
  if (!adminKey) throw new Error('Relé por configurar');
  const origin = originFor(relay);
  const snapshot = buildCustomerPortalSnapshot(db, clientId, now);
  const secret = createPortalSecret();
  const { id, key } = derivePortalLink(secret);
  const expiresAt = now.getTime() + 24 * 60 * 60 * 1000;
  const body = JSON.stringify({ envelope: encryptPortalSnapshot(key, snapshot), expiresAt });
  db.prepare('INSERT INTO customer_portal_links (id, client_id, relay_origin, expires_at) VALUES (?, ?, ?, ?)').run(id, clientId, origin, expiresAt);
  const response = await fetch(`${origin}/customer/${id}/snapshot`, { method: 'PUT', headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Não foi possível publicar a página');
  db.prepare("UPDATE customer_portal_links SET published_at = datetime('now') WHERE id = ?").run(id);
  return { id, expiresAt, url: `${origin}/c#${secret}` };
}

export async function revokeCustomerPortal(db: Database.Database, id: string, relay: string, adminKey: string) {
  if (!/^[a-f0-9]{64}$/.test(id) || !adminKey) throw new Error('Pedido inválido');
  const link = db.prepare('SELECT relay_origin AS origin FROM customer_portal_links WHERE id = ?').get(id) as { origin: string } | undefined;
  if (!link) throw new Error('Ligação não encontrada');
  if (originFor(relay) !== link.origin) throw new Error('O endereço do relé mudou; restaure-o para revogar este link');
  const response = await fetch(`${link.origin}/customer/${id}/snapshot`, { method: 'DELETE', headers: { authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Não foi possível revogar a ligação');
  db.prepare("UPDATE customer_portal_links SET revoked_at = datetime('now') WHERE id = ?").run(id);
}

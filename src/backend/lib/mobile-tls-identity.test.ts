import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { connect, createServer } from 'node:tls';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { loadMobileTlsIdentity } from './mobile-tls-identity';
import type { LocalProtection } from './local-protection';

function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}

const protection: LocalProtection = {
  available: () => true,
  seal: value => `enc:v1:${Buffer.from(value).toString('base64')}`,
  open: value => Buffer.from(value.slice(7), 'base64').toString()
};

describe('mobile TLS identity', () => {
  it('persists a locally protected key and reuses the same certificate', async () => {
    const db = database();
    try {
      const first = await loadMobileTlsIdentity(db, protection);
      const second = await loadMobileTlsIdentity(db, protection);
      expect(second).toEqual(first);
      const cert = new X509Certificate(first.certificatePem);
      expect(cert.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(first.fingerprintSha256);
      expect(createPublicKey(createPrivateKey(first.privateKeyPem)).export({type:'spki', format:'pem'}))
        .toBe(cert.publicKey.export({type:'spki', format:'pem'}));
      const stored = (db.prepare('SELECT value FROM app_settings').get() as {value:string}).value;
      expect(stored).toMatch(/^enc:v1:/);
      expect(stored).not.toContain('PRIVATE KEY');
    } finally { db.close(); }
  });

  it('fails closed if local protection is unavailable', async () => {
    const db = database();
    try {
      await expect(loadMobileTlsIdentity(db, {...protection, available: () => false})).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n: 0});
    } finally { db.close(); }
  });

  it('does not persist a key if local sealing fails', async () => {
    const db = database();
    try {
      await expect(loadMobileTlsIdentity(db, {...protection, seal: () => { throw new Error('LOCAL_PROTECTION_FAILED'); }})).rejects.toThrow('LOCAL_PROTECTION_FAILED');
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n: 0});
    } finally { db.close(); }
  });

  it('does not silently replace a damaged identity', async () => {
    const db = database();
    try {
      db.prepare("INSERT INTO app_settings(key, value) VALUES ('mobile_tls_identity', 'invalid')").run();
      await expect(loadMobileTlsIdentity(db, protection)).rejects.toThrow();
      expect(db.prepare('SELECT value FROM app_settings').get()).toEqual({value: 'invalid'});
    } finally { db.close(); }
  });

  it('rejects a sealed certificate paired with a different private key', async () => {
    const db = database();
    const otherDb = database();
    try {
      const identity = await loadMobileTlsIdentity(db, protection);
      const other = await loadMobileTlsIdentity(otherDb, protection);
      const corrupted = protection.seal(JSON.stringify({
        certificatePem: identity.certificatePem,
        privateKeyPem: other.privateKeyPem
      }));
      db.prepare("UPDATE app_settings SET value = ? WHERE key = 'mobile_tls_identity'").run(corrupted);
      await expect(loadMobileTlsIdentity(db, protection)).rejects.toThrow('MOBILE_TLS_IDENTITY_INVALID');
      expect(db.prepare('SELECT value FROM app_settings').get()).toEqual({value: corrupted});
    } finally { db.close(); otherDb.close(); }
  });

  it('returns one identity when creation is requested concurrently', async () => {
    const db = database();
    try {
      const identities = await Promise.all(Array.from({ length: 4 }, () => loadMobileTlsIdentity(db, protection)));
      expect(new Set(identities.map(identity => identity.fingerprintSha256)).size).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n: 1});
    } finally { db.close(); }
  });

  it('supports a TLS handshake with the trusted certificate and rejects a different one', async () => {
    const firstDb = database();
    const secondDb = database();
    const first = await loadMobileTlsIdentity(firstDb, protection);
    const second = await loadMobileTlsIdentity(secondDb, protection);
    const server = createServer({ cert: first.certificatePem, key: first.privateKeyPem });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = (server.address() as { port: number }).port;
      const handshake = (ca: string) => new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port, ca, servername: 'ispm.local' });
        socket.once('secureConnect', () => { socket.end(); resolve(); });
        socket.once('error', reject);
      });
      await expect(handshake(first.certificatePem)).resolves.toBeUndefined();
      await expect(handshake(second.certificatePem)).rejects.toThrow();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      firstDb.close();
      secondDb.close();
    }
  });
});

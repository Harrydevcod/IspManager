import 'reflect-metadata';
import { createPrivateKey, createPublicKey, X509Certificate, webcrypto } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import type { LocalProtection } from './local-protection';

const SETTING_KEY = 'mobile_tls_identity';
const CERTIFICATE_LIFETIME_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export type MobileTlsIdentity = {
  certificatePem: string;
  privateKeyPem: string;
  fingerprintSha256: string;
};

function decodeIdentity(value: string, protection: LocalProtection): MobileTlsIdentity {
  try {
    if (!value.startsWith('enc:v1:')) throw new Error('invalid envelope');
    const decoded: unknown = JSON.parse(protection.open(value));
    if (!decoded || typeof decoded !== 'object') throw new Error('invalid identity');
    const { certificatePem, privateKeyPem } = decoded as Record<string, unknown>;
    if (typeof certificatePem !== 'string' || typeof privateKeyPem !== 'string') throw new Error('invalid identity');
    const certificate = new X509Certificate(certificatePem);
    const key = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    if (!publicKey.equals(certificateKey) || !certificate.verify(certificate.publicKey)) throw new Error('invalid certificate');
    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) throw new Error('expired certificate');
    return { certificatePem, privateKeyPem, fingerprintSha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase() };
  } catch {
    throw new Error('MOBILE_TLS_IDENTITY_INVALID');
  }
}

/** A device identity is never stored without OS protection or silently rotated. */
export async function loadMobileTlsIdentity(db: Database.Database, protection: LocalProtection): Promise<MobileTlsIdentity> {
  if (!protection.available()) throw new Error('LOCAL_PROTECTION_UNAVAILABLE');
  const read = () => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  const existing = read();
  if (existing) return decodeIdentity(existing.value, protection);

  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const now = Date.now();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: 'CN=ispm.local',
    keys,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + CERTIFICATE_LIFETIME_MS),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new SubjectAlternativeNameExtension([{ type: 'dns', value: 'ispm.local' }]),
      new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'])
    ]
  }, crypto);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  const privateKeyPem = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
  const value = protection.seal(JSON.stringify({ certificatePem: certificate.toString('pem'), privateKeyPem }));
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING`).run(SETTING_KEY, value);
  const stored = read();
  if (!stored) throw new Error('MOBILE_TLS_IDENTITY_UNAVAILABLE');
  return decodeIdentity(stored.value, protection);
}

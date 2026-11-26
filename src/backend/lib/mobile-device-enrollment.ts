import { createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LocalProtection } from './local-protection';
import { inspectMobileClientCertificate } from './mobile-client-certificate';
import { timingSafeEqualString, verifyResponseSignature } from './sms-signing';

const SETTING_KEY = 'mobile_trusted_device';
const MAX_PROOF_BYTES = 16 * 1024;
export type MobilePairing = { version: number; secret: string };
export type MobileDevice = { certificatePem: string; fingerprintSha256: string };
type PairingReader = () => MobilePairing | null;
type ProofReader = (nonce: string) => Promise<{body: Buffer; signature: string | null}>;

function activePairing(readPairing: PairingReader): MobilePairing | null {
  const pairing = readPairing();
  return pairing?.version === 2 && /^[a-f\d]{64}$/i.test(pairing.secret) ? { version: 2, secret: pairing.secret } : null;
}

function binding(pairing: MobilePairing, fingerprint: string): string {
  return createHmac('sha256', Buffer.from(pairing.secret, 'hex')).update(`ispm-mobile-device-v1\n${fingerprint}`).digest('hex');
}

function decodeRecord(value: string, protection: LocalProtection): {device: MobileDevice; pairingBinding: string} {
  try {
    if (!value.startsWith('enc:v1:')) throw new Error();
    const record: unknown = JSON.parse(protection.open(value));
    if (!record || typeof record !== 'object') throw new Error();
    const { version, certificatePem, pairingBinding } = record as Record<string, unknown>;
    if (version !== 1 || typeof certificatePem !== 'string' || typeof pairingBinding !== 'string' || !/^[a-f\d]{64}$/i.test(pairingBinding)) throw new Error();
    return {device: inspectMobileClientCertificate(certificatePem), pairingBinding};
  } catch { throw new Error('MOBILE_DEVICE_RECORD_CORRUPT'); }
}

/** A device record is valid only for the currently active v2 SMS pairing. */
export function readEnrolledMobileDevice(db: Database.Database, protection: LocalProtection, readPairing: PairingReader): MobileDevice | null {
  if (!protection.available()) return null;
  const pairing = activePairing(readPairing);
  if (!pairing) return null;
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as {value: string} | undefined;
  if (!row?.value.startsWith('enc:v1:')) return null;
  try {
    const {device, pairingBinding} = decodeRecord(row.value, protection);
    return timingSafeEqualString(binding(pairing, device.fingerprintSha256), pairingBinding) ? device : null;
  } catch { return null; }
}

/** Explicit enrollment: the phone must sign a fresh challenge with the existing pairing secret. */
export async function enrollMobileDevice(db: Database.Database, protection: LocalProtection, readPairing: PairingReader, requestProof: ProofReader): Promise<MobileDevice> {
  if (!protection.available()) throw new Error('LOCAL_PROTECTION_UNAVAILABLE');
  const pairing = activePairing(readPairing);
  if (!pairing) throw new Error('MOBILE_V2_PAIRING_REQUIRED');
  const nonce = randomUUID();
  const proof = await requestProof(nonce);
  if (!Buffer.isBuffer(proof.body) || proof.body.length > MAX_PROOF_BYTES || !verifyResponseSignature(pairing.secret, nonce, proof.body, proof.signature)) throw new Error('MOBILE_DEVICE_PROOF_INVALID');
  let certificatePem: unknown;
  try { certificatePem = (JSON.parse(proof.body.toString('utf8')) as {certificatePem?: unknown}).certificatePem; }
  catch { throw new Error('MOBILE_DEVICE_PROOF_INVALID'); }
  if (typeof certificatePem !== 'string') throw new Error('MOBILE_DEVICE_PROOF_INVALID');
  const device = inspectMobileClientCertificate(certificatePem);
  const currentPairing = activePairing(readPairing);
  if (!currentPairing || currentPairing.secret !== pairing.secret) throw new Error('MOBILE_PAIRING_CHANGED');
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as {value: string} | undefined;
  if (row) {
    const existing = decodeRecord(row.value, protection);
    if (timingSafeEqualString(binding(pairing, existing.device.fingerprintSha256), existing.pairingBinding)) {
      if (existing.device.fingerprintSha256 === device.fingerprintSha256) return existing.device;
      throw new Error('MOBILE_DEVICE_ALREADY_ENROLLED');
    }
  }
  const record = protection.seal(JSON.stringify({version:1, certificatePem:device.certificatePem, pairingBinding:binding(pairing, device.fingerprintSha256)}));
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(SETTING_KEY, record);
  return device;
}

/** Called only by the explicit forget-device workflow. */
export function forgetMobileDevice(db: Database.Database): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(SETTING_KEY);
}

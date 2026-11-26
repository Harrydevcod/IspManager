import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { LocalProtection } from './local-protection';
import { loadMobileTlsIdentity, type MobileTlsIdentity } from './mobile-tls-identity';
import { readSecret } from './secrets';
import { enrollMobileDevice, readEnrolledMobileDevice } from './mobile-device-enrollment';
import { requestMobileDeviceProof, sendDesktopIdentity } from './mobile-device-proof';
import { randomUUID } from 'node:crypto';
import { verifyResponseSignature } from './sms-signing';
import { createBackendMobileGateway } from './mobile-gateway-backend';
import { authBypassed, isSetupComplete } from './auth';

type ProofRequest = (baseUrl: string, nonce: string) => Promise<{body: Buffer; signature: string | null}>;

function setting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as {value:string} | undefined;
  return row?.value?.trim() ?? '';
}

function readSmsPairing(db: Database.Database) {
  return {version:setting(db,'smsCompanionPairingVersion') === '2' ? 2 : 0, secret:readSecret(db,'smsCompanionPairingKey')};
}

/** Explicit enrollment through the already paired phone; no server is started here. */
export async function enrollPairedMobileDevice(db: Database.Database, protection: LocalProtection, requestProof: ProofRequest = requestMobileDeviceProof) {
  const baseUrl = setting(db, 'smsCompanionBaseUrl');
  if (!baseUrl) throw new Error('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  return enrollMobileDevice(db, protection, () => readSmsPairing(db), nonce => requestProof(baseUrl, nonce));
}

type IdentityRequest = (baseUrl: string, nonce: string, identity: {host: string; port: number; certificatePem: string}) => Promise<{body: Buffer; signature: string | null}>;

/** Publish only to an enrolled phone and require its signed acknowledgement. */
export async function publishDesktopIdentity(db: Database.Database, protection: LocalProtection, identity: MobileTlsIdentity, host: string, port: number, request: IdentityRequest = sendDesktopIdentity): Promise<void> {
  const pairing = readSmsPairing(db);
  const device = readEnrolledMobileDevice(db, protection, () => readSmsPairing(db));
  if (!device) throw new Error('MOBILE_DEVICE_NOT_ENROLLED');
  const baseUrl = setting(db, 'smsCompanionBaseUrl');
  if (!baseUrl) throw new Error('MOBILE_DEVICE_PROOF_UNAVAILABLE');
  const nonce = randomUUID();
  const proof = await request(baseUrl, nonce, {host, port, certificatePem: identity.certificatePem});
  if (!Buffer.isBuffer(proof.body) || proof.body.length > 16 * 1024 || !verifyResponseSignature(pairing.secret, nonce, proof.body, proof.signature)) throw new Error('MOBILE_DESKTOP_ACK_INVALID');
  try {
    if (JSON.parse(proof.body.toString('utf8'))?.ok !== true) throw new Error();
  } catch { throw new Error('MOBILE_DESKTOP_ACK_INVALID'); }
  const current = readSmsPairing(db);
  if (current.version !== pairing.version || current.secret !== pairing.secret || setting(db, 'smsCompanionBaseUrl') !== baseUrl || readEnrolledMobileDevice(db, protection, () => current)?.fingerprintSha256 !== device.fingerprintSha256) throw new Error('MOBILE_PAIRING_CHANGED');
}

/** Construct, but do not bind, the gateway for the currently enrolled phone. */
export function createPairedMobileGateway(app: FastifyInstance, db: Database.Database, protection: LocalProtection, identity: MobileTlsIdentity) {
  const current = () => readEnrolledMobileDevice(db, protection, () => readSmsPairing(db));
  const device = current();
  if (!device) throw new Error('MOBILE_DEVICE_NOT_ENROLLED');
  return createBackendMobileGateway(app, identity, device.certificatePem, fingerprint => current()?.fingerprintSha256 === fingerprint);
}

/** Prepare an inactive gateway and publish its address only after it binds. */
export async function preparePairedMobileGateway(app: FastifyInstance, db: Database.Database, protection: LocalProtection, requestProof: ProofRequest = requestMobileDeviceProof, sendIdentity: IdentityRequest = sendDesktopIdentity) {
  if (authBypassed() || !isSetupComplete()) throw new Error('MOBILE_AUTH_REQUIRED');
  const pairing = readSmsPairing(db);
  if (pairing.version !== 2 || !pairing.secret || !setting(db, 'smsCompanionBaseUrl')) throw new Error('MOBILE_V2_PAIRING_REQUIRED');
  const identity = await loadMobileTlsIdentity(db, protection);
  await enrollPairedMobileDevice(db, protection, requestProof);
  if (authBypassed() || !isSetupComplete()) throw new Error('MOBILE_AUTH_REQUIRED');
  const server = createPairedMobileGateway(app, db, protection, identity);
  return {server, publish: async (host: string, port: number) => {
    if (authBypassed() || !isSetupComplete()) throw new Error('MOBILE_AUTH_REQUIRED');
    await publishDesktopIdentity(db, protection, identity, host, port, sendIdentity);
    if (authBypassed() || !isSetupComplete()) throw new Error('MOBILE_AUTH_REQUIRED');
  }};
}

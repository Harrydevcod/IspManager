import 'reflect-metadata';
import { webcrypto, X509Certificate } from 'node:crypto';
import Database from 'better-sqlite3';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { createResponseSignature } from './sms-signing';
import { enrollMobileDevice, readEnrolledMobileDevice, forgetMobileDevice } from './mobile-device-enrollment';

const secret = 'a1'.repeat(32);
const protection = { available:()=>true, seal:(s:string)=>'enc:v1:'+Buffer.from(s).toString('base64'), open:(s:string)=>Buffer.from(s.slice(7),'base64').toString() };
function database() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return db;
}
async function certificate(oid: string | null = '1.3.6.1.5.5.7.3.2') {
  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({name:'CN=phone',keys,notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+86400000),signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},extensions:[new BasicConstraintsExtension(false,undefined,true),new KeyUsagesExtension(KeyUsageFlags.digitalSignature,true),...(oid ? [new ExtendedKeyUsageExtension([oid])] : [])]},crypto);
  return cert.toString('pem');
}

describe('mobile device enrollment', () => {
  it('enrolls only a signed response, bound to the active v2 pairing', async () => {
    const db = database();
    try {
      const pem = await certificate();
      const expected = new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase();
      let pairing = {version:2,secret};
      let receivedNonce = '';
      const getPairing = () => pairing;
      const registered = await enrollMobileDevice(db, protection, getPairing, async nonce => {
        receivedNonce = nonce;
        const body = Buffer.from(JSON.stringify({certificatePem:pem}));
        return {body, signature:createResponseSignature(secret,nonce,body)};
      });
      expect(receivedNonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(registered.fingerprintSha256).toBe(expected);
      expect(readEnrolledMobileDevice(db, protection, getPairing)?.fingerprintSha256).toBe(expected);
      const row = db.prepare('SELECT value FROM app_settings').get() as {value:string};
      expect(row.value).toMatch(/^enc:v1:/);
      expect(row.value).not.toContain(pem);
      pairing = {version:2,secret:'b2'.repeat(32)};
      expect(readEnrolledMobileDevice(db, protection, getPairing)).toBeNull();
      pairing = {version:1,secret};
      expect(readEnrolledMobileDevice(db, protection, getPairing)).toBeNull();
      forgetMobileDevice(db);
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n:0});
    } finally { db.close(); }
  });

  it('refuses a forged signature and a certificate for server authentication', async () => {
    const db = database();
    try {
      const pem = await certificate();
      const pairing = () => ({version:2,secret});
      await expect(enrollMobileDevice(db, protection, pairing, async nonce => {
        const body = Buffer.from(JSON.stringify({certificatePem:pem}));
        return {body,signature:createResponseSignature('b2'.repeat(32),nonce,body)};
      })).rejects.toThrow();
      await expect(enrollMobileDevice(db, protection, pairing, async () => {
        const body = Buffer.from(JSON.stringify({certificatePem:pem}));
        return {body,signature:createResponseSignature(secret,'old-nonce',body)};
      })).rejects.toThrow('MOBILE_DEVICE_PROOF_INVALID');
      const serverPem = await certificate('1.3.6.1.5.5.7.3.1');
      await expect(enrollMobileDevice(db, protection, pairing, async nonce => {
        const body = Buffer.from(JSON.stringify({certificatePem:serverPem}));
        return {body,signature:createResponseSignature(secret,nonce,body)};
      })).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n:0});
    } finally { db.close(); }
  });

  it('refuses legacy pairings and missing local protection before contacting the phone', async () => {
    const db = database();
    let contacted = false;
    const request = async () => { contacted=true; return {body:Buffer.alloc(0), signature:null}; };
    try {
      await expect(enrollMobileDevice(db, protection, () => ({version:1,secret}), request)).rejects.toThrow('MOBILE_V2_PAIRING_REQUIRED');
      await expect(enrollMobileDevice(db, {...protection, available:()=>false}, () => ({version:2,secret}), request)).rejects.toThrow('LOCAL_PROTECTION_UNAVAILABLE');
      expect(contacted).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n:0});
    } finally { db.close(); }
  });

  it('accepts a signed client certificate with no extended-key-usage restriction', async () => {
    const db = database();
    try {
      const pem = await certificate(null);
      const device = await enrollMobileDevice(db, protection, () => ({version:2,secret}), async nonce => {
        const body = Buffer.from(JSON.stringify({certificatePem:pem}));
        return {body, signature:createResponseSignature(secret,nonce,body)};
      });
      expect(device.fingerprintSha256).toBe(new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase());
    } finally { db.close(); }
  });

  it('rejects pairing changes while awaiting proof and does not silently replace a phone', async () => {
    const db = database();
    try {
      const pem = await certificate();
      let pairing = {version:2,secret};
      const getPairing = () => pairing;
      await expect(enrollMobileDevice(db, protection, getPairing, async nonce => {
        const body=Buffer.from(JSON.stringify({certificatePem:pem}));
        pairing.secret='b2'.repeat(32);
        return {body,signature:createResponseSignature(secret,nonce,body)};
      })).rejects.toThrow();
      expect(db.prepare('SELECT count(*) AS n FROM app_settings').get()).toEqual({n:0});
      pairing={version:2,secret};
      const proof = (pem:string) => async (nonce:string) => { const body=Buffer.from(JSON.stringify({certificatePem:pem}));return {body,signature:createResponseSignature(secret,nonce,body)}; };
      await enrollMobileDevice(db, protection, getPairing, proof(pem));
      await expect(enrollMobileDevice(db, protection, getPairing, proof(await certificate()))).rejects.toThrow();
      expect(readEnrolledMobileDevice(db, protection, getPairing)?.fingerprintSha256).toBe(new X509Certificate(pem).fingerprint256.replaceAll(':','').toLowerCase());
    } finally { db.close(); }
  });

  it('replaces an old pairing only after a valid proof and rejects corrupt records', async () => {
    const db = database();
    try {
      const first = await certificate();
      const second = await certificate();
      let pairing = {version: 2, secret};
      const proof = (pem: string, signingSecret: string) => async (nonce: string) => {
        const body = Buffer.from(JSON.stringify({certificatePem: pem}));
        return {body, signature: createResponseSignature(signingSecret, nonce, body)};
      };
      await enrollMobileDevice(db, protection, () => pairing, proof(first, secret));
      const old = db.prepare('SELECT value FROM app_settings').get();
      pairing = {version: 2, secret: 'b2'.repeat(32)};
      await expect(enrollMobileDevice(db, protection, () => pairing, proof(second, secret))).rejects.toThrow('MOBILE_DEVICE_PROOF_INVALID');
      expect(db.prepare('SELECT value FROM app_settings').get()).toEqual(old);
      await enrollMobileDevice(db, protection, () => pairing, proof(second, pairing.secret));
      expect(readEnrolledMobileDevice(db, protection, () => pairing)?.fingerprintSha256).toBe(new X509Certificate(second).fingerprint256.replaceAll(':', '').toLowerCase());
      db.prepare("UPDATE app_settings SET value = 'corrupt'").run();
      await expect(enrollMobileDevice(db, protection, () => pairing, proof(second, pairing.secret))).rejects.toThrow('MOBILE_DEVICE_RECORD_CORRUPT');
    } finally { db.close(); }
  });
});

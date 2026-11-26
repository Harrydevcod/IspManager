import 'reflect-metadata';
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';
import { Agent, request } from 'node:https';
import Database from 'better-sqlite3';
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { loadMobileTlsIdentity } from './mobile-tls-identity';
import { createMobileGateway } from './mobile-gateway';

async function clientIdentity() {
  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    name:'CN=ISPM mobile client', keys, notBefore:new Date(Date.now()-60000), notAfter:new Date(Date.now()+86400000),
    signingAlgorithm:{name:'ECDSA', hash:'SHA-256'},
    extensions:[new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'])]
  }, crypto);
  const key = createPrivateKey({key:Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)), format:'der', type:'pkcs8'}).export({type:'pkcs8', format:'pem'}).toString();
  return {cert:cert.toString('pem'), key};
}

describe('mobile gateway', () => {
  it('withholds a response when the device is revoked during application processing', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    const protection = {available:()=>true, seal:(s:string)=>'enc:v1:'+Buffer.from(s).toString('base64'), open:(s:string)=>Buffer.from(s.slice(7),'base64').toString()};
    const identity = await loadMobileTlsIdentity(db, protection);
    const client = await clientIdentity();
    let allowed = true;
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const gateway = createMobileGateway({identity, trustedClientCertificatePem:client.cert, isDeviceAllowed: () => allowed,
      authReady: () => true, isUserAuthenticated: () => true,
      dispatch: async () => { entered(); await gate; return {statusCode:200, headers:{}, body:Buffer.from('private')}; }});
    await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    try {
      const port = (gateway.address() as {port:number}).port;
      const response = new Promise<{status:number; body:string}>((resolve, reject) => {
        const req = request({host:'127.0.0.1', port, path:'/api/clients', ca:identity.certificatePem, servername:'ispm.local', ...client, headers:{authorization:'Bearer valid'}}, res => {
          const chunks:Buffer[] = []; res.on('data', (chunk:Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({status:res.statusCode!, body:Buffer.concat(chunks).toString()}));
        });
        req.on('error', reject); req.end();
      });
      await started;
      allowed = false;
      finish();
      const result = await response;
      expect(result.status).toBe(403);
      expect(result.body).not.toContain('private');
    } finally { finish(); await new Promise<void>(resolve => gateway.close(() => resolve())); db.close(); }
  });

  it('does not dispatch a request if the device is revoked during its upload', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    const protection = {available:()=>true, seal:(s:string)=>'enc:v1:'+Buffer.from(s).toString('base64'), open:(s:string)=>Buffer.from(s.slice(7),'base64').toString()};
    const identity = await loadMobileTlsIdentity(db, protection);
    const client = await clientIdentity();
    let allowed = true;
    let entered!: () => void;
    const checked = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const gateway = createMobileGateway({identity, trustedClientCertificatePem:client.cert,
      isDeviceAllowed: () => { entered(); return allowed; }, authReady: () => true,
      isUserAuthenticated: () => true,
      dispatch: async () => { calls++; return {statusCode:200, headers:{}, body:Buffer.from('ok')}; }});
    await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
    try {
      const port = (gateway.address() as {port:number}).port;
      const req = request({host:'127.0.0.1', port, path:'/api/clients', method:'POST', ca:identity.certificatePem, servername:'ispm.local', ...client, headers:{authorization:'Bearer valid', 'content-length':'2'}});
      const response = new Promise<number>((resolve, reject) => { req.once('error', reject); req.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); }); });
      req.write('a');
      await checked;
      await new Promise<void>(resolve => setImmediate(resolve));
      allowed = false;
      req.end('b');
      expect(await response).toBe(403);
      expect(calls).toBe(0);
    } finally { await new Promise<void>(resolve => gateway.close(() => resolve())); db.close(); }
  });

  it('requires a paired TLS client, active authentication and a valid user session', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    const protection = {available:()=>true, seal:(s:string)=>'enc:v1:'+Buffer.from(s).toString('base64'), open:(s:string)=>Buffer.from(s.slice(7),'base64').toString()};
    const identity = await loadMobileTlsIdentity(db, protection);
    const client = await clientIdentity();
    const stranger = await clientIdentity();
    const trustedFingerprint = new X509Certificate(client.cert).fingerprint256.replaceAll(':', '').toLowerCase();
    let allowed = true;
    let authEnabled = true;
    let calls = 0;
    const gateway = createMobileGateway({
      identity,
      trustedClientCertificatePem: client.cert,
      isDeviceAllowed: fingerprint => allowed && fingerprint === trustedFingerprint,
      authReady: () => authEnabled,
      isUserAuthenticated: token => token === 'valid',
      dispatch: async input => { calls++; return {statusCode: 200, headers:{'content-type':'text/plain'}, body:Buffer.from(input.url)}; }
    });
    await new Promise<void>((resolve, reject) => { gateway.once('error',reject); gateway.listen(0,'127.0.0.1',resolve); });
    const port = (gateway.address() as {port:number}).port;
    async function get(path:string, token?:string, withClient=true, selectedClient=client, agent?:Agent, method='GET'):Promise<{status:number, body:string}> {
      return await new Promise((resolve, reject) => {
        const req = request({host:'127.0.0.1', port, path, method, agent, ca:identity.certificatePem, servername:'ispm.local', ...(withClient ? selectedClient : {}), headers:token ? {authorization:`Bearer ${token}`} : {}}, res => {
          const chunks:Buffer[]=[]; res.on('data',(c:Buffer)=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));
        });
        req.on('error',reject); req.end();
      });
    }
    try {
      await expect(get('/api/clients','valid',false)).rejects.toThrow();
      await expect(get('/api/clients','valid',true,stranger)).rejects.toThrow();
      expect((await get('/api/clients')).status).toBe(401);
      expect((await get('/api/clients','invalid')).status).toBe(401);
      expect((await get('/health')).status).toBe(200);
      expect((await get('/api/auth/status')).status).toBe(200);
      expect((await get('/api/auth/login',undefined,true,client,undefined,'POST')).status).toBe(200);
      expect((await get('/api/auth/setup','valid')).status).toBe(403);
      expect((await get('/api/auth/%73etup','valid')).status).toBe(403);
      expect((await get('/api/auth/%2573etup','valid')).status).toBe(403);
      expect((await get('/api/auth%2fsetup','valid')).status).toBe(403);
      expect((await get('/api/auth/setup%3fother','valid')).status).toBe(403);
      expect((await get('/api/auth/setup%23other','valid')).status).toBe(403);
      expect((await get('/api/a/%2e%2e/auth/setup','valid')).status).toBe(403);
      expect((await get('/api/clients%00','valid')).status).toBe(403);
      expect(await get('/api/clients?status=active','valid')).toEqual({status:200,body:'/api/clients?status=active'});
      expect(calls).toBe(4);
      const agent = new Agent({keepAlive:true, maxSockets:1});
      expect((await get('/api/clients','valid',true,client,agent)).status).toBe(200);
      allowed=false;
      expect((await get('/api/clients','valid',true,client,agent)).status).toBe(403);
      agent.destroy();
      allowed=true; authEnabled=false;
      expect((await get('/api/clients','valid')).status).toBe(503);
      expect(calls).toBe(5);
    } finally { await new Promise<void>(resolve=>gateway.close(()=>resolve())); db.close(); }
  });
});

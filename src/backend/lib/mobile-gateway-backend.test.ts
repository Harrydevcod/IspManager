import 'reflect-metadata';
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BasicConstraintsExtension, KeyUsageFlags, KeyUsagesExtension, X509CertificateGenerator } from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { loadMobileTlsIdentity } from './mobile-tls-identity';
import { forgetMobileDevice } from './mobile-device-enrollment';
import { enrollPairedMobileDevice, createPairedMobileGateway, publishDesktopIdentity, preparePairedMobileGateway } from './mobile-device-controller';
import { MobileGatewayLifecycle } from './mobile-gateway-lifecycle';
import { createResponseSignature } from './sms-signing';

async function phoneCert() {
  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({name:'CN=phone', keys, notBefore:new Date(Date.now()-60000), notAfter:new Date(Date.now()+86400000), signingAlgorithm:{name:'ECDSA', hash:'SHA-256'}, extensions:[new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true)]}, crypto);
  const key = createPrivateKey({key:Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)), format:'der',type:'pkcs8'}).export({type:'pkcs8',format:'pem'}).toString();
  return {cert:cert.toString('pem'), key};
}

describe('mobile gateway and real backend', () => {
  it('preserves authentication and refuses bypass, setup, or a revoked device', async () => {
    const dir = mkdtempSync(path.join(tmpdir(),'ispm-mobile-gateway-'));
    process.env.ISPM_DATA_DIR = dir;
    process.env.ISPM_AUTO_BILLING = 'off';
    delete process.env.ISPM_AUTH;
    const protection = {available:()=>true, seal:(s:string)=>'enc:v1:'+Buffer.from(s).toString('base64'), open:(s:string)=>Buffer.from(s.slice(7),'base64').toString()};
    const { createBackendApp } = await import('../server');
    const { getSqliteDatabase, closeDatabaseForTests } = await import('../db/database');
    const { resetAuthSecretCache } = await import('./auth');
    const app = await createBackendApp({localProtection:protection});
    await app.ready();
    const db = getSqliteDatabase();
    const { writeSecret } = await import('./secrets');
    const identity = await loadMobileTlsIdentity(db, protection);
    const phone = await phoneCert();
    const fingerprint = new X509Certificate(phone.cert).fingerprint256.replaceAll(':','').toLowerCase();
    const secret = 'ab'.repeat(32);
    writeSecret(db, 'smsCompanionPairingKey', secret);
    db.prepare("INSERT INTO app_settings(key,value) VALUES('smsCompanionPairingVersion','2')").run();
    db.prepare("INSERT INTO app_settings(key,value) VALUES('smsCompanionBaseUrl','http://192.168.1.20:8765')").run();
    const enrolled = await enrollPairedMobileDevice(db, protection, async (address, nonce) => {
      expect(address).toBe('http://192.168.1.20:8765');
      const body = Buffer.from(JSON.stringify({certificatePem:phone.cert}));
      return {body, signature:createResponseSignature(secret,nonce,body)};
    });
    expect(enrolled.fingerprintSha256).toBe(fingerprint);
    await expect(publishDesktopIdentity(db, protection, identity, '192.168.1.10', 38421, async (_address, nonce, payload) => {
      expect(payload).toEqual({host:'192.168.1.10',port:38421,certificatePem:identity.certificatePem});
      const body = Buffer.from('{"ok":true}');
      return {body,signature:createResponseSignature(secret,nonce,body)};
    })).resolves.toBeUndefined();
    await expect(publishDesktopIdentity(db, protection, identity, '192.168.1.10', 38421, async (_address, nonce) => {
      const body = Buffer.from('{"ok":true}');
      return {body,signature:createResponseSignature('cd'.repeat(32),nonce,body)};
    })).rejects.toThrow('MOBILE_DESKTOP_ACK_INVALID');
    await expect(publishDesktopIdentity(db, protection, identity, '192.168.1.10', 38421, async (_address, nonce) => {
      writeSecret(db, 'smsCompanionPairingKey', 'cd'.repeat(32));
      const body = Buffer.from('{"ok":true}');
      return {body, signature:createResponseSignature(secret, nonce, body)};
    })).rejects.toThrow('MOBILE_PAIRING_CHANGED');
    writeSecret(db, 'smsCompanionPairingKey', secret);
    const gateway = createPairedMobileGateway(app, db, protection, identity);
    await new Promise<void>((resolve,reject)=>{gateway.once('error',reject);gateway.listen(0,'127.0.0.1',resolve);});
    const port = (gateway.address() as {port:number}).port;
    async function call(method:string, target:string, body?:object, token?:string):Promise<{status:number, body:any}> {
      return await new Promise((resolve,reject)=>{
        const payload = body ? JSON.stringify(body) : undefined;
        const req=request({host:'127.0.0.1',port,method,path:target,ca:identity.certificatePem,servername:'ispm.local',...phone,headers:{'x-forwarded-for':'198.51.100.7',...(payload ? {'content-type':'application/json'} : {}),...(token ? {authorization:`Bearer ${token}`} : {})}},res=>{
          const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();resolve({status:res.statusCode!,body:JSON.parse(raw)});});
        });
        req.on('error',reject);req.end(payload);
      });
    }
    try {
      expect((await call('GET','/api/auth/status')).status).toBe(503);
      await expect(preparePairedMobileGateway(app, db, protection)).rejects.toThrow('MOBILE_AUTH_REQUIRED');
      const setup = await app.inject({method:'POST',url:'/api/auth/setup',payload:{username:'admin',password:'supersecret',fullName:'Admin'}});
      expect(setup.statusCode).toBe(201);
      const managed = new MobileGatewayLifecycle({allowedAddress: host => host === '127.0.0.1', prepare: () => preparePairedMobileGateway(app, db, protection,
        async (_address, nonce) => { const body = Buffer.from(JSON.stringify({certificatePem:phone.cert})); return {body, signature:createResponseSignature(secret,nonce,body)}; },
        async (_address, nonce) => { const body = Buffer.from('{"ok":true}'); return {body, signature:createResponseSignature(secret,nonce,body)}; })});
      const managedAddress = await managed.start('127.0.0.1', 0);
      expect(managedAddress.port).toBeGreaterThan(0);
      await managed.stop();
      expect((await call('GET','/health')).body).toEqual({ok:true, service:'ispm-backend'});
      expect((await call('POST','/api/auth/setup',{username:'other',password:'supersecret',fullName:'Other'})).status).toBe(403);
      const login = await call('POST','/api/auth/login',{username:'admin',password:'supersecret'});
      expect(login.status).toBe(200);
      expect((await call('POST','/api/mobile-access/stop',{},login.body.token)).status).toBe(403);
      const mobileStatus = await app.inject({method:'GET', url:'/api/mobile-access', headers:{authorization:`Bearer ${login.body.token}`}});
      expect(mobileStatus.statusCode).toBe(200);
      expect(mobileStatus.json().running).toBe(false);
      expect((await app.inject({method:'GET', url:'/api/mobile-access'})).statusCode).toBe(401);
      expect((await app.inject({method:'POST', url:'/api/mobile-access/stop'})).statusCode).toBe(401);
      const invalidStart = await app.inject({method:'POST', url:'/api/mobile-access/start', headers:{authorization:`Bearer ${login.body.token}`}, payload:{host:'0.0.0.0', port:38421, confirmPassword:'supersecret'}});
      expect(invalidStart.statusCode).toBe(400);
      const localAddress = mobileStatus.json().addresses[0] as string | undefined;
      if (localAddress) {
        const wrongPassword = await app.inject({method:'POST', url:'/api/mobile-access/start', headers:{authorization:`Bearer ${login.body.token}`}, payload:{host:localAddress, port:38421, confirmPassword:'incorrect'}});
        expect(wrongPassword.statusCode).toBe(403);
        const afterFailure = await app.inject({method:'GET', url:'/api/mobile-access', headers:{authorization:`Bearer ${login.body.token}`}});
        expect(afterFailure.json().running).toBe(false);
      }
      const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'login_success' AND summary = 'admin' ORDER BY id DESC LIMIT 1").get() as {metadata_json:string};
      expect(JSON.parse(audit.metadata_json).ip).toBe('127.0.0.1');
      expect((await call('GET','/api/clients')).status).toBe(401);
      expect((await call('GET','/api/clients',undefined,login.body.token)).status).toBe(200);
      const created = await app.inject({method:'POST',url:'/api/users',headers:{authorization:`Bearer ${login.body.token}`},payload:{username:'operator',password:'operatorpw',fullName:'Operator',role:'operator'}});
      expect(created.statusCode).toBe(201);
      const operator = await call('POST','/api/auth/login',{username:'operator',password:'operatorpw'});
      expect(operator.status).toBe(200);
      expect((await app.inject({method:'GET', url:'/api/mobile-access', headers:{authorization:`Bearer ${operator.body.token}`}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST', url:'/api/mobile-access/stop', headers:{authorization:`Bearer ${operator.body.token}`}})).statusCode).toBe(403);
      expect((await call('GET','/api/users',undefined,operator.body.token)).status).toBe(403);
      expect((await call('GET','/api/users',undefined,login.body.token)).status).toBe(200);
      for (let i = 0; i < 5; i++) {
        expect((await call('POST','/api/auth/login',{username:'operator',password:'incorrect'})).status).toBe(401);
      }
      expect((await call('POST','/api/auth/login',{username:'operator',password:'operatorpw'})).status).toBe(429);
      writeSecret(db, 'smsCompanionPairingKey', 'cd'.repeat(32));
      expect((await call('GET','/api/clients',undefined,login.body.token)).status).toBe(403);
      writeSecret(db, 'smsCompanionPairingKey', secret);
      db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'smsCompanionPairingVersion'").run();
      expect((await call('GET','/api/clients',undefined,login.body.token)).status).toBe(403);
      db.prepare("UPDATE app_settings SET value = '2' WHERE key = 'smsCompanionPairingVersion'").run();
      process.env.ISPM_AUTH='off';
      expect((await call('GET','/api/clients',undefined,login.body.token)).status).toBe(503);
      await expect(preparePairedMobileGateway(app, db, protection)).rejects.toThrow('MOBILE_AUTH_REQUIRED');
      delete process.env.ISPM_AUTH;
      forgetMobileDevice(db);
      expect((await call('GET','/api/clients',undefined,login.body.token)).status).toBe(403);
      expect(() => createPairedMobileGateway(app, db, protection, identity)).toThrow('MOBILE_DEVICE_NOT_ENROLLED');
    } finally {
      delete process.env.ISPM_AUTH; delete process.env.ISPM_DATA_DIR; delete process.env.ISPM_AUTO_BILLING;
      await new Promise<void>(resolve=>gateway.close(()=>resolve())); await app.close(); closeDatabaseForTests(); resetAuthSecretCache();
      rmSync(dir,{recursive:true,force:true});
    }
  }, 30000);
});

/**
 * O cofre de ponta a ponta, numa base temporária e com auth a sério.
 *
 * Credenciais antigas em claro → migração na máquina A → uma senha trocada →
 * backup → o backup restaurado na máquina B (outra proteção local, que não abre
 * o que a A selou) → login funciona → cofre trancado → desbloqueio com a chave
 * de recuperação → o router (falso) recebe a senha verdadeira, e nenhuma
 * resposta da API a contém em momento algum.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { closeDatabaseForTests, getSqliteDatabase } from '../db/database';
import { createBackup, resolveBackupDir } from '../lib/backup';
import type { LocalProtection } from '../lib/local-protection';
import { runNetworkEnforcement } from '../lib/network-enforcement';
import type { RouterRequest, RouterTransport } from '../lib/routeros';
import { readSecret } from '../lib/secrets';

const ROUTER_LEGADO = 'marcador-router-legado-7';
const ULTRA_LEGADO = 'marcador-ultramsg-legado-8';
const PPPOE_LEGADO = 'marcador-pppoe-legado-9';
const PPPOE_NOVA = 'marcador-pppoe-nova-10';
const MARCADORES = [ROUTER_LEGADO, ULTRA_LEGADO, PPPOE_LEGADO, PPPOE_NOVA];
const ADMIN = { username: 'admin', password: 'supersecret', fullName: 'Admin' };

/** Cada máquina só abre o que ela própria selou, como o DPAPI. */
function machine(id: string): LocalProtection {
  return {
    available: () => true,
    seal: (value: string) => `${id}:${value}`,
    open: (stored: string) => {
      if (!stored.startsWith(`${id}:`)) throw new Error('OTHER_MACHINE');
      return stored.slice(id.length + 1);
    }
  };
}

const dirs: string[] = [];
let app: FastifyInstance | null = null;
/** Tudo o que a API respondeu durante o teste, para procurar fugas no fim. */
const bodies: string[] = [];

function useDataDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  process.env.ISPM_DATA_DIR = dir;
  return dir;
}

async function boot(protection: LocalProtection) {
  const { createBackendApp } = await import('../server');
  app = await createBackendApp({ localProtection: protection });
  await app.ready();
  return app;
}

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) {
  const response = await app!.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {})
  });
  bodies.push(response.body);
  return response;
}

async function flags(token: string) {
  const settings = (await call('GET', '/api/settings', token)).json() as Record<string, unknown>;
  const services = (await call('GET', '/api/services', token)).json() as Array<Record<string, unknown>>;
  return {
    routerosPasswordConfigured: settings.routerosPasswordConfigured,
    ultraMsgTokenConfigured: settings.ultraMsgTokenConfigured,
    pppoePasswordConfigured: services.map((service) => service.pppoePasswordConfigured)
  };
}

function recordingRouter() {
  const calls: RouterRequest[] = [];
  const transport = (async (request: RouterRequest) => {
    calls.push(request);
    if (request.path.startsWith('/ppp/profile?')) return [{ '.id': '*P0', name: 'plano-10M' }];
    if (request.method === 'PUT') return { '.id': '*77' };
    if (request.method === 'GET') return [];
    return null;
  }) as RouterTransport;
  return { transport, calls };
}

afterEach(async () => {
  await app?.close();
  app = null;
  closeDatabaseForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  bodies.length = 0;
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});

describe('cofre de ponta a ponta', () => {
  test('restauro noutra máquina: trancado, desbloqueado pela chave, e o router recebe a senha verdadeira', async () => {
    process.env.ISPM_AUTO_BILLING = 'off';
    process.env.ISPM_RECURRING_EXPENSES = 'off';
    delete process.env.ISPM_AUTH;

    // 1. Uma base de uma versão anterior: credenciais guardadas em claro.
    useDataDir('ispm-vault-e2e-a-');
    const legacy = getSqliteDatabase();
    legacy.prepare(`INSERT INTO clients (id, client_code, full_name, status) VALUES (1, 'C001', 'Sandra', 'active')`).run();
    legacy.prepare(`
      INSERT INTO internet_plans (id, name, download_speed, upload_speed, download_mbps, upload_mbps, router_profile)
      VALUES (1, 'Base 10', '10 Mbps', '2 Mbps', 10, 2, 'plano-10M')
    `).run();
    legacy.prepare(`
      INSERT INTO services (id, client_id, plan_id, monthly_value_cve, due_day, status, pppoe_username, pppoe_password)
      VALUES (1, 1, 1, 250000, 1, 'active', 'sandra', ?)
    `).run(PPPOE_LEGADO);
    const setting = legacy.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
    setting.run('routerosPassword', ROUTER_LEGADO);
    setting.run('ultraMsgToken', ULTRA_LEGADO);
    closeDatabaseForTests();

    // 2. Máquina A: o arranque converte tudo para o cofre, sem texto claro na base.
    await boot(machine('A'));
    const db = getSqliteDatabase();
    const stored = db.prepare(`
      SELECT (SELECT pppoe_password FROM services WHERE id = 1) AS pppoe,
             (SELECT value FROM app_settings WHERE key = 'routerosPassword') AS router,
             (SELECT value FROM app_settings WHERE key = 'ultraMsgToken') AS ultra
    `).get() as Record<string, string>;
    for (const value of Object.values(stored)) expect(value.startsWith('enc:v2:')).toBe(true);

    const setup = await call('POST', '/api/auth/setup', undefined, ADMIN);
    expect(setup.statusCode).toBe(201);
    const tokenA = setup.json().token as string;
    const before = await flags(tokenA);
    expect(before).toEqual({ routerosPasswordConfigured: true, ultraMsgTokenConfigured: true, pppoePasswordConfigured: [true] });

    // 3. Troca-se uma senha pela ação dedicada.
    expect((await call('PATCH', '/api/services/1/pppoe-password', tokenA, { password: PPPOE_NOVA })).statusCode).toBe(200);

    // 4. O administrador guarda a chave de recuperação.
    const delivered = await call('POST', '/api/vault/recovery-key', tokenA, { password: ADMIN.password });
    expect(delivered.statusCode).toBe(200);
    const recoveryKey = delivered.json().recoveryKey as string;
    expect((await call('POST', '/api/vault/confirm', tokenA, { recoveryKey })).statusCode).toBe(200);

    // 5. Backup, e a máquina A desaparece.
    const backup = await createBackup('manual');
    const backupFile = path.join(resolveBackupDir(), backup.file);
    const copyDir = useDataDir('ispm-vault-e2e-backup-');
    copyFileSync(backupFile, path.join(copyDir, 'backup.sqlite'));
    await app!.close();
    app = null;
    closeDatabaseForTests();

    // 6. Máquina B: o backup vira a base. O login funciona; o cofre não abre.
    const dirB = useDataDir('ispm-vault-e2e-b-');
    copyFileSync(path.join(copyDir, 'backup.sqlite'), path.join(dirB, 'ispm.sqlite'));
    await boot(machine('B'));
    const login = await call('POST', '/api/auth/login', undefined, { username: ADMIN.username, password: ADMIN.password });
    expect(login.statusCode).toBe(200);
    const tokenB = login.json().token as string;
    expect((await call('GET', '/api/vault/status', tokenB)).json().status).toBe('locked');
    expect(readSecret(getSqliteDatabase(), 'routerosPassword')).toBe('');

    // 7. A chave de recuperação abre o cofre; as credenciais voltam intactas.
    const unlocked = await call('POST', '/api/vault/unlock', tokenB, { recoveryKey });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json().status).toBe('ready');
    expect(await flags(tokenB)).toEqual(before);
    expect(readSecret(getSqliteDatabase(), 'routerosPassword')).toBe(ROUTER_LEGADO);

    // 8. O router recebe a senha verdadeira do cliente.
    const router = recordingRouter();
    await runNetworkEnforcement(getSqliteDatabase(), { transport: router.transport, dryRun: false, maxDisables: 5 });
    const created = router.calls.find((request) => request.method === 'PUT' && request.path === '/ppp/secret');
    expect(created?.body).toMatchObject({ name: 'sandra', password: PPPOE_NOVA });

    // Em nenhum momento a API devolveu uma credencial.
    const everything = bodies.join('\n');
    for (const marker of MARCADORES) expect(everything).not.toContain(marker);
  });
});

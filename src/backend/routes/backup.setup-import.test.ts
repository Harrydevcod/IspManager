import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-setupimport-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  app = await server.createBackendApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // O último teste reabre a BD (insert do user) — fechar antes do rm (Windows lock).
  const { closeDatabaseForTests } = await import('../db/database');
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('POST /api/backups/setup-import (primeiro arranque)', () => {
  test('restaura um backup válido enquanto não existem utilizadores', async () => {
    // Um backup real: o de arranque criado pelo próprio servidor.
    const list = (await app.inject({ method: 'GET', url: '/api/backups' })).json() as {
      backupDir: string;
      entries: Array<{ file: string }>;
    };
    const sourcePath = path.join(list.backupDir, list.entries[0].file);

    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/setup-import',
      payload: { path: sourcePath }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().restartRequired).toBe(true);
  });

  test('rejeita ficheiro inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/setup-import',
      payload: { path: path.join(dataDir, 'nao-existe.sqlite') }
    });
    expect(res.statusCode).toBe(400);
  });

  test('fecha-se assim que existe um utilizador (setup completo → 409)', async () => {
    const { getSqliteDatabase } = await import('../db/database');
    getSqliteDatabase().prepare(`
      INSERT INTO users (username, password_hash, role, full_name, active)
      VALUES ('admin', 'hash', 'admin', 'Admin', 1)
    `).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/setup-import',
      payload: { path: path.join(dataDir, 'qualquer.sqlite') }
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Setup ja foi concluido');
  });
});

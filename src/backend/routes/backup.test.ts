import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-bkroute-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  app = await server.createBackendApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('backup routes', () => {
  test('GET /api/backups lists at least the startup backup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/backups' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.backupDir).toBe('string');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/backups creates a new backup', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    const res = await app.inject({ method: 'POST', url: '/api/backups' });
    expect(res.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    expect(after.entries.length).toBeGreaterThanOrEqual(before.entries.length);
  });

  test('POST /api/backups/restore rejects path traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      payload: { file: '../../etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('POST /api/backups/restore returns restartRequired for a real backup', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/backups' })).json();
    const file = list.entries[0].file as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/backups/restore',
      payload: { file },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().restartRequired).toBe(true);
  });
});

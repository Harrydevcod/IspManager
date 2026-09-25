import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { fakeMachine } from './credentials.testing';
import { createLocalProtection } from './local-protection';
import { loadSessionSecret } from './session-secret';

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function stored(db: Database.Database): string {
  return (db.prepare("SELECT value FROM app_settings WHERE key = 'auth_secret'").get() as { value: string } | undefined)?.value ?? '';
}

test('selada só nesta máquina, e estável entre arranques', () => {
  const db = memoryDb();
  const first = loadSessionSecret(db, fakeMachine('A'));
  expect(first.length).toBe(48);
  expect(stored(db).startsWith('enc:v1:')).toBe(true);
  expect(stored(db)).not.toContain(first.toString('hex'));
  expect(loadSessionSecret(db, fakeMachine('A')).equals(first)).toBe(true);
});

test('noutra máquina recria a assinatura (todos entram outra vez)', () => {
  const db = memoryDb();
  const onA = loadSessionSecret(db, fakeMachine('A'));
  const onB = loadSessionSecret(db, fakeMachine('B'));
  expect(onB.equals(onA)).toBe(false);
  expect(loadSessionSecret(db, fakeMachine('B')).equals(onB)).toBe(true);
});

test('uma assinatura antiga em claro não é reaproveitada', () => {
  const db = memoryDb();
  const legacy = 'ab'.repeat(48);
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('auth_secret', ?)").run(legacy);
  const secret = loadSessionSecret(db, fakeMachine('A'));
  expect(secret.toString('hex')).not.toBe(legacy);
  expect(stored(db).startsWith('enc:v1:')).toBe(true);
});

test('sem proteção local nunca grava: assinatura efémera, base intocada', () => {
  const db = memoryDb();
  loadSessionSecret(db, fakeMachine('A'));
  const before = stored(db);
  const ephemeral = loadSessionSecret(db, createLocalProtection(null));
  expect(ephemeral.length).toBe(48);
  expect(stored(db)).toBe(before);
});

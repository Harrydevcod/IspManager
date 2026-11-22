import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';

describe('remoção da caixa de SMS', () => {
  test('remove a tabela quando está vazia', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations.filter((m) => m.version < 113));
    runMigrations(db, migrations);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sms_inbox'").get()).toBeUndefined();
    db.close();
  });

  test('preserva mensagens e interrompe a migração quando há dados', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations.filter((m) => m.version < 113));
    db.prepare("INSERT INTO companion_events (id, kind, occurred_at, payload_json, status) VALUES ('event-123', 'sms_in', '2026-11-22', '{}', 'applied')").run();
    db.prepare("INSERT INTO sms_inbox (event_id, phone, body, received_at) VALUES ('event-123', '9912345', 'mensagem', '2026-11-22')").run();
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(db.prepare('SELECT body FROM sms_inbox').get()).toEqual({ body: 'mensagem' });
    db.close();
  });
});

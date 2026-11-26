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

  test('arquiva todos os campos e aplica a migração de forma idempotente', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations.filter((m) => m.version < 113));
    db.prepare("INSERT INTO companion_events (id, kind, occurred_at, payload_json, status) VALUES ('event-123', 'sms_in', '2026-11-22', '{}', 'applied')").run();
    db.prepare("INSERT INTO sms_inbox (event_id, phone, body, received_at) VALUES ('event-123', '9912345', 'mensagem', '2026-11-22')").run();
    const original = db.prepare('SELECT * FROM sms_inbox').get();
    runMigrations(db, migrations);
    runMigrations(db, migrations);
    expect(db.prepare('SELECT * FROM sms_inbox_archive').get()).toEqual(original);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sms_inbox_archive').get()).toEqual({ n: 1 });
    db.close();
  });

  test('reverte o arquivo e mantém a caixa quando a cópia falha', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations.filter((m) => m.version < 113));
    db.prepare("INSERT INTO companion_events (id, kind, occurred_at, payload_json, status) VALUES ('event-123', 'sms_in', '2026-11-22', '{}', 'applied')").run();
    db.prepare("INSERT INTO sms_inbox (event_id, phone, body, received_at) VALUES ('event-123', '9912345', 'mensagem', '2026-11-22')").run();
    db.exec('CREATE TABLE sms_inbox_archive (id INTEGER PRIMARY KEY)');
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(db.prepare('SELECT body FROM sms_inbox').get()).toEqual({ body: 'mensagem' });
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 113').get()).toBeUndefined();
    db.close();
  });

  test('cria o arquivo numa instalação que já aplicou a 0113', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations.filter((m) => m.version <= 113));
    db.exec('DROP TABLE sms_inbox_archive');
    runMigrations(db, migrations);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sms_inbox_archive').get()).toEqual({ n: 0 });
    db.close();
  });
});

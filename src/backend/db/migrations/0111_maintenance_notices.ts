import type { Migration } from './types';

/**
 * Aviso de manutenção, calibração ou mudança de configuração numa torre ou ramo: um aviso por
 * equipamento e janela, e um destinatário por cliente a jusante (chave única: não se repete).
 * Os textos ficam gravados como saíram, para o recurso a SMS e para a auditoria.
 */
const migration: Migration = {
  version: 111,
  name: 'maintenance_notices',
  sql: `
    CREATE TABLE maintenance_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backbone_device_id INTEGER NOT NULL REFERENCES backbone_devices(id),
      kind TEXT NOT NULL CHECK (kind IN ('manutencao', 'calibracao', 'configuracao')),
      day TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      whatsapp_body TEXT NOT NULL,
      sms_body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE maintenance_notice_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id INTEGER NOT NULL REFERENCES maintenance_notices(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
      outbox_id INTEGER NOT NULL,
      UNIQUE (notice_id, client_id)
    );
    CREATE INDEX idx_maintenance_recipients_outbox ON maintenance_notice_recipients (channel, outbox_id);
  `
};
export default migration;

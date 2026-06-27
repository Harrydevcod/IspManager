import type { Migration } from './types';

/**
 * Alarga os tipos de aviso de `whatsapp_notices` para o funil de cobrança
 * (dunning) configurável: além de `overdue`/`suspension`, passa a aceitar
 * `reminder` (antes do vencimento) e `warning` (lembrete intermédio).
 *
 * O CHECK de uma migration já lançada é imutável (o runner deteta drift de
 * checksum), por isso reconstrói-se a tabela em vez de a editar. Preserva todas
 * as colunas (incl. `outbox_id`, adicionada na 0015), os dados e o índice de
 * dedupe. O runner corre com `foreign_keys` desligado, logo o drop/rename com
 * referências FK é seguro.
 *
 * Versão 24: 20–23 ficam reservadas para branches em curso (numeração /
 * centavos / login throttle / job_runs); o runner tolera gaps.
 */
const migration: Migration = {
  version: 24,
  name: 'dunning_funnel_notice_types',
  sql: `
    CREATE TABLE whatsapp_notices_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      notice_type TEXT NOT NULL CHECK(notice_type IN ('reminder', 'overdue', 'warning', 'suspension')),
      origin TEXT NOT NULL CHECK(origin IN ('auto', 'manual')) DEFAULT 'auto',
      phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'failed')) DEFAULT 'sent',
      error TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      outbox_id INTEGER REFERENCES whatsapp_outbox(id)
    );

    INSERT INTO whatsapp_notices_new
      (id, payment_id, client_id, notice_type, origin, phone, body, status, error, sent_at, outbox_id)
    SELECT
      id, payment_id, client_id, notice_type, origin, phone, body, status, error, sent_at, outbox_id
    FROM whatsapp_notices;

    DROP TABLE whatsapp_notices;
    ALTER TABLE whatsapp_notices_new RENAME TO whatsapp_notices;

    CREATE INDEX IF NOT EXISTS idx_whatsapp_notices_dedupe
      ON whatsapp_notices(payment_id, notice_type, sent_at);
  `
};

export default migration;

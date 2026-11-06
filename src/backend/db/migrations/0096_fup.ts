import type { Migration } from './types';

/**
 * Política de uso justo (FUP).
 *
 * - `internet_plans.fup_reference_gb`: consumo de referência do ciclo; 0 = o
 *   plano não tem FUP e ninguém nele é avisado nem limitado.
 * - `internet_plans.fup_peak_percent`: % da velocidade na janela de pico quando
 *   limitado; nulo = a configuração global.
 * - `services.fup_cycle_day`: dia em que o ciclo começa; nulo = o dia da
 *   ativação (até 28).
 * - `fup_events`: as transições. A chave única (serviço, período, tipo) é o que
 *   impede um segundo aviso no mesmo ciclo.
 * - `fup_settings` / `fup_settings_history`: a configuração e o registo de cada
 *   alteração, que nunca se altera nem apaga.
 */
const migration: Migration = {
  version: 96,
  name: 'fup',
  sql: `
    ALTER TABLE internet_plans ADD COLUMN fup_reference_gb INTEGER NOT NULL DEFAULT 0 CHECK (fup_reference_gb >= 0);
    ALTER TABLE internet_plans ADD COLUMN fup_peak_percent INTEGER CHECK (fup_peak_percent IS NULL OR fup_peak_percent BETWEEN 1 AND 200);
    ALTER TABLE services ADD COLUMN fup_cycle_day INTEGER CHECK (fup_cycle_day IS NULL OR fup_cycle_day BETWEEN 1 AND 28);

    UPDATE internet_plans SET fup_reference_gb = 150 WHERE lower(trim(name)) IN ('básico', 'basico');
    UPDATE internet_plans SET fup_reference_gb = 300 WHERE lower(trim(name)) = 'standard';
    UPDATE internet_plans SET fup_reference_gb = 600 WHERE lower(trim(name)) = 'premium';

    CREATE TABLE fup_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('AVISO', 'LIMITADO', 'RESTAURADO')),
      detail_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (service_id, period, kind)
    );
    CREATE INDEX idx_fup_events_service ON fup_events (service_id, id);

    CREATE TABLE fup_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('NUMERO', 'TEXTO', 'HORA', 'FUSO')),
      updated_at TEXT,
      updated_by TEXT
    );
    INSERT INTO fup_settings (key, value, type) VALUES
      ('limiar_aviso_percent', '80', 'NUMERO'),
      ('limiar_limitacao_percent', '100', 'NUMERO'),
      ('percent_velocidade_pico', '50', 'NUMERO'),
      ('janela_pico_inicio', '18:00', 'HORA'),
      ('janela_pico_fim', '23:00', 'HORA'),
      ('fuso_horario', 'Atlantic/Cape_Verde', 'FUSO'),
      ('intervalo_recolha_minutos', '5', 'NUMERO'),
      ('canal_aviso', 'WHATSAPP', 'TEXTO'),
      ('fup_aplicacao_metodo', 'PROFILE', 'TEXTO'),
      ('mensagem_aviso', 'Caro cliente {nome}, já usou {percent}% do consumo de referência do seu plano ({gb} de {referencia} GB) neste ciclo. Ao chegar aos 100%, a velocidade entre as {inicio} e as {fim} passa a {pico}% da contratada até ao próximo ciclo.', 'TEXTO');

    CREATE TABLE fup_settings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT
    );
    CREATE INDEX idx_fup_settings_history_key ON fup_settings_history (key, changed_at);
    CREATE TRIGGER fup_settings_history_no_update BEFORE UPDATE ON fup_settings_history
      BEGIN SELECT RAISE(ABORT, 'O histórico da configuração FUP não se altera'); END;
    CREATE TRIGGER fup_settings_history_no_delete BEFORE DELETE ON fup_settings_history
      BEGIN SELECT RAISE(ABORT, 'O histórico da configuração FUP não se apaga'); END;

    -- O aviso FUP por SMS precisa do seu tipo; o CHECK só muda reconstruindo a tabela.
    CREATE TABLE sms_outbox_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      payment_id INTEGER REFERENCES payments(id),
      service_id INTEGER REFERENCES services(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('invoice_issued','receipt_confirmed','payment_overdue','suspension_notice','test','fup_notice')),
      to_phone TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_dispatch','pending_approval','approved','sent','failed','rejected','cancelled')) DEFAULT 'pending_dispatch',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      next_attempt_at TEXT,
      android_request_id TEXT,
      approved_at TEXT,
      sent_at TEXT,
      rejected_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      failed_at TEXT,
      delivered_at TEXT
    );
    INSERT INTO sms_outbox_new (id, client_id, payment_id, service_id, event_type, to_phone, body, status, attempts, max_attempts,
      last_error, next_attempt_at, android_request_id, approved_at, sent_at, rejected_at, created_at, updated_at, failed_at, delivered_at)
    SELECT id, client_id, payment_id, service_id, event_type, to_phone, body, status, attempts, max_attempts,
      last_error, next_attempt_at, android_request_id, approved_at, sent_at, rejected_at, created_at, updated_at, failed_at, delivered_at
    FROM sms_outbox;
    DROP TABLE sms_outbox;
    ALTER TABLE sms_outbox_new RENAME TO sms_outbox;
    CREATE INDEX idx_sms_outbox_ready ON sms_outbox(status, next_attempt_at);
    CREATE INDEX idx_sms_outbox_payment_event ON sms_outbox(payment_id, event_type);
    CREATE UNIQUE INDEX idx_sms_outbox_android_request ON sms_outbox(android_request_id) WHERE android_request_id IS NOT NULL;
    CREATE INDEX idx_sms_outbox_created_status ON sms_outbox(created_at, status);
  `
};

export default migration;

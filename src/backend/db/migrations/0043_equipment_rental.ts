import type { Migration } from './types';

/**
 * Aluguer de equipamento e equipamento do cliente.
 *
 * Até aqui o cliente pagava um número só (`services.monthly_value_cve`), com o
 * aluguer embutido à mão — o `equipment_catalog.rental_fee_cve` existia mas não
 * entrava em fatura nenhuma. O modelo passa a ser explícito: plano + aluguer de
 * cada equipamento instalado que seja do ISP.
 *
 * Duas decisões que ficam gravadas aqui:
 *
 * 1. **A propriedade é da atribuição, não do serviço.** Um cliente pode ter
 *    comprado o router e continuar a alugar a antena.
 *
 * 2. **A renda é copiada do catálogo, não lida em tempo real.** É a mesma razão
 *    pela qual `services.monthly_value_cve` é um instantâneo: mudar o preço de
 *    aluguer de um modelo no catálogo não pode reescrever com efeito retroativo
 *    a fatura de toda a gente que tem esse modelo instalado.
 *
 * O CHECK de `payment_lines.kind` alarga-se por rebuild da tabela, no molde da
 * 0029 — o SQLite não altera um CHECK no sítio.
 */
const migration: Migration = {
  version: 43,
  name: 'equipment_rental',
  sql: `
    ALTER TABLE service_device_assignments
      ADD COLUMN ownership TEXT NOT NULL DEFAULT 'isp';
    ALTER TABLE service_device_assignments
      ADD COLUMN owned_since TEXT;
    ALTER TABLE service_device_assignments
      ADD COLUMN rental_fee_cve REAL NOT NULL DEFAULT 0;

    -- Instantâneo da renda em vigor para o equipamento já instalado. Sem isto,
    -- todas as atribuições existentes ficariam a 0 e o aluguer só começaria a
    -- ser cobrado a quem fosse instalado de novo.
    UPDATE service_device_assignments
    SET rental_fee_cve = COALESCE((
      SELECT ec.rental_fee_cve FROM equipment_catalog ec WHERE ec.id = service_device_assignments.catalog_id
    ), 0);

    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE payment_lines_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id),
      kind TEXT NOT NULL CHECK(kind IN ('internet','audiovisual','instalacao','aluguer','equipamento')),
      description TEXT NOT NULL,
      amount_cve REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO payment_lines_new (id, payment_id, kind, description, amount_cve, sort_order, created_at)
    SELECT id, payment_id, kind, description, amount_cve, sort_order, created_at
    FROM payment_lines;

    DROP TABLE payment_lines;
    ALTER TABLE payment_lines_new RENAME TO payment_lines;

    CREATE INDEX IF NOT EXISTS idx_payment_lines_payment ON payment_lines(payment_id);

    -- Só as atribuições ainda instaladas e do ISP entram na fatura; é por aqui
    -- que a geração mensal passa uma vez por serviço.
    CREATE INDEX IF NOT EXISTS idx_assignments_rental
      ON service_device_assignments(service_id, end_date, ownership);
  `
};

export default migration;

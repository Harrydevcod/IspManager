import type { Migration } from './types';

/**
 * Integração MikroTik: identidade PPPoE por serviço, velocidade legível por
 * máquina no plano e o estado lido do router.
 *
 * `pppoe_username` é a intenção: quem *deve* existir como secret no router. O
 * secret em falta passa a ser uma divergência que o job de reconciliação
 * resolve — não há um segundo caminho de escrita a partir da criação do serviço
 * (ver ADR 0007).
 *
 * `download_mbps`/`upload_mbps` existem porque `download_speed` é texto livre
 * ("10 Mbps", "10M", "Ilimitado") e um rate-limit adivinhado de um texto
 * ambíguo estrangula um cliente que paga. O pré-preenchimento abaixo só toca
 * nos casos inequívocos; o resto fica NULL e o job não escreve velocidade
 * nenhuma até alguém preencher o número.
 */
const migration: Migration = {
  version: 39,
  name: 'pppoe_provisioning',
  sql: `
    ALTER TABLE services ADD COLUMN pppoe_username TEXT;
    ALTER TABLE services ADD COLUMN pppoe_password TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_services_pppoe_username
      ON services(pppoe_username) WHERE pppoe_username IS NOT NULL;

    ALTER TABLE internet_plans ADD COLUMN download_mbps INTEGER;
    ALTER TABLE internet_plans ADD COLUMN upload_mbps INTEGER;

    UPDATE internet_plans
    SET download_mbps = CAST(TRIM(REPLACE(REPLACE(REPLACE(LOWER(download_speed), 'mbps', ''), 'mb', ''), 'm', '')) AS INTEGER)
    WHERE TRIM(REPLACE(REPLACE(REPLACE(LOWER(download_speed), 'mbps', ''), 'mb', ''), 'm', '')) GLOB '[0-9]*'
      AND TRIM(REPLACE(REPLACE(REPLACE(LOWER(download_speed), 'mbps', ''), 'mb', ''), 'm', '')) NOT GLOB '*[^0-9]*';

    UPDATE internet_plans
    SET upload_mbps = CAST(TRIM(REPLACE(REPLACE(REPLACE(LOWER(upload_speed), 'mbps', ''), 'mb', ''), 'm', '')) AS INTEGER)
    WHERE TRIM(REPLACE(REPLACE(REPLACE(LOWER(upload_speed), 'mbps', ''), 'mb', ''), 'm', '')) GLOB '[0-9]*'
      AND TRIM(REPLACE(REPLACE(REPLACE(LOWER(upload_speed), 'mbps', ''), 'mb', ''), 'm', '')) NOT GLOB '*[^0-9]*';

    -- Realidade do router por serviço: o que lá está e o que está online agora.
    -- A intenção continua a viver em services.status; esta tabela nunca a altera.
    CREATE TABLE IF NOT EXISTS service_network_state (
      service_id INTEGER PRIMARY KEY REFERENCES services(id),
      secret_id TEXT,
      router_enabled INTEGER,
      desired_enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      uptime TEXT,
      last_online_at TEXT,
      divergence TEXT,
      last_error TEXT,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `
};

export default migration;

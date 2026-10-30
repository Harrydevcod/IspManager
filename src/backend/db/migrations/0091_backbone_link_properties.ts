import type { Migration } from './types';

/**
 * O que liga duas unidades de backbone: o meio, as portas de cada ponta e, num
 * rádio, a frequência e a capacidade. Tudo opcional — as ligações que já existem
 * ficam como estavam, "por classificar", até alguém as descrever.
 *
 * Sinal e SNR não entram aqui: são leituras, não configuração, e só aparecerão
 * quando houver monitorização das próprias CPE.
 */
const migration: Migration = {
  version: 91,
  name: 'backbone_link_properties',
  sql: `
    ALTER TABLE backbone_links ADD COLUMN medium TEXT
      CHECK (medium IS NULL OR medium IN ('ethernet', 'fibra', 'ptp', 'ptmp', 'wan'));
    ALTER TABLE backbone_links ADD COLUMN from_port TEXT;
    ALTER TABLE backbone_links ADD COLUMN to_port TEXT;
    ALTER TABLE backbone_links ADD COLUMN frequency_mhz INTEGER
      CHECK (frequency_mhz IS NULL OR frequency_mhz BETWEEN 1 AND 100000);
    ALTER TABLE backbone_links ADD COLUMN capacity_mbps INTEGER
      CHECK (capacity_mbps IS NULL OR capacity_mbps BETWEEN 1 AND 1000000);
    ALTER TABLE backbone_links ADD COLUMN notes TEXT;
    ALTER TABLE backbone_links ADD COLUMN updated_at TEXT;
  `
};

export default migration;

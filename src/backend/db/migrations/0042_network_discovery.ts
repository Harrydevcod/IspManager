import type { Migration } from './types';

/**
 * Histórico da descoberta de rede: o que já foi visto, e desde quando.
 *
 * A chave é o **IP**, não o MAC. Chavear pelo MAC parece mais correto — é o MAC
 * que identifica o equipamento — mas parte-se sozinho: o primeiro varrimento vê
 * o endereço pelo ping antes de a tabela ARP estar populada (sem MAC) e o
 * seguinte já com MAC, o que dava duas linhas para o mesmo equipamento e fazia o
 * "apareceu de novo na rede" mentir logo à segunda utilização. Num backbone de
 * ISP os endereços são estáticos, portanto o IP é a identidade estável.
 *
 * ponytail: se algum dia houver um segmento DHCP puro onde os equipamentos
 * saltem de endereço, a chave passa a (mac, ip) e esta tabela é reconstruída.
 *
 * `first_seen_at` é o único motivo de a tabela existir: sem ela a aba responde
 * "quem está na rede", com ela responde "quem apareceu esta semana".
 */
const migration: Migration = {
  version: 42,
  name: 'network_discovery',
  sql: `
    CREATE TABLE IF NOT EXISTS network_discovery_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address TEXT NOT NULL UNIQUE,
      mac_address TEXT,
      hostname TEXT,
      vendor TEXT,
      -- Como foi visto da última vez: 'ping' (respondeu), 'arp' (tabela local
      -- da máquina) ou 'router' (ARP/leases do MikroTik).
      source TEXT NOT NULL DEFAULT 'ping',
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      times_seen INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_network_discovery_hosts_seen
      ON network_discovery_hosts(last_seen_at);
  `
};

export default migration;

import type { Migration } from './types';

/**
 * IPTV via VPN (ADR 0021). A marca é do serviço e só técnica: não fatura.
 * Os fornecedores IPTV dão as entradas `ispm-iptv-srv:*` da lista de servidores.
 * `lan_cidr` é a gama da LAN de um router de cliente, para avisar quando colide
 * com uma gama do ISP.
 */
const migration: Migration = {
  version: 89,
  name: 'iptv_via_vpn',
  sql: `
    CREATE TABLE iptv_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hosts TEXT NOT NULL DEFAULT '',
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE services ADD COLUMN iptv_vpn INTEGER NOT NULL DEFAULT 0 CHECK(iptv_vpn IN (0,1));
    ALTER TABLE services ADD COLUMN iptv_provider_id INTEGER REFERENCES iptv_providers(id) ON DELETE SET NULL;
    ALTER TABLE service_device_assignments ADD COLUMN lan_cidr TEXT;
  `
};

export default migration;

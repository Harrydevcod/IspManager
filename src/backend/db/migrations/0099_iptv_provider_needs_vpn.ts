import type { Migration } from './types';

/**
 * Nem todo o fornecedor de IPTV precisa da VPN: os que não precisam seguem pelas WAN
 * e os servidores deles ficam fora da lista do router. Os existentes foram criados
 * para a VPN, por isso o default é 1 e o router não muda ao atualizar.
 */
const migration: Migration = {
  version: 99,
  name: 'iptv_provider_needs_vpn',
  sql: `
    ALTER TABLE iptv_providers ADD COLUMN needs_vpn INTEGER NOT NULL DEFAULT 1 CHECK(needs_vpn IN (0,1));
  `
};

export default migration;

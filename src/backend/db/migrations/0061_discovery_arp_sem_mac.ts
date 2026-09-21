import type { Migration } from './types';

/**
 * Tirar da Descoberta as entradas ARP falhadas do router.
 *
 * O varrimento pinga cada endereço do intervalo através do router de gestão, e
 * o MikroTik guarda uma linha no `/ip/arp` por cada endereço que tentou
 * resolver — com ou sem resposta. As que ficaram sem resposta não têm MAC, e
 * entravam na lista como equipamento "desconhecido": na base real eram 398 de
 * 586, a /24 inteira de `192.168.1.x` e de `192.168.100.x`.
 *
 * O caminho de entrada já ficou fechado no `listArp`. Isto limpa o que entrou
 * antes. Só sai o que o router reportou sem nada que o identifique — sem MAC,
 * sem nome e sem modelo; o resto foi de facto visto.
 */
const migration: Migration = {
  version: 61,
  name: 'discovery_arp_sem_mac',
  sql: `
    DELETE FROM network_discovery_hosts
     WHERE source = 'router'
       AND mac_address IS NULL
       AND hostname IS NULL
       AND model IS NULL;
  `
};

export default migration;

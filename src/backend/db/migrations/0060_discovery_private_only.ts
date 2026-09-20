import type { Migration } from './types';

/**
 * Tirar da Descoberta o que nunca foi rede local.
 *
 * O retrato da rede juntava, ao varrimento do intervalo, o que o router de
 * gestão sabe — `/ip/arp`, os aluguer de DHCP e os vizinhos. Só que o MikroTik
 * encaminha também as duas ligações Starlink e reporta-as como reporta tudo o
 * resto: uma dúzia de endereços em `100.64.0.0/10`, o bloco que os operadores
 * usam entre si, mais um `26.0.0.1` de outro interface. Apareciam na lista como
 * equipamento "desconhecido", sem MAC, sem nunca terem sido varridos.
 *
 * O caminho de entrada já ficou fechado. Isto limpa o que entrou antes: a
 * tabela acumula por endereço e só esquece ao fim de 90 dias sem ser vista — e
 * como o router os repetia a cada varrimento, nunca chegavam lá.
 *
 * Não é documento nem histórico, é o que se viu na rede da última vez. Volta a
 * encher-se sozinha no varrimento seguinte.
 */
const migration: Migration = {
  version: 60,
  name: 'discovery_private_only',
  sql: `
    DELETE FROM network_discovery_hosts
     WHERE NOT (
       ip_address GLOB '10.*'
       OR ip_address GLOB '192.168.*'
       OR ip_address GLOB '172.1[6-9].*'
       OR ip_address GLOB '172.2[0-9].*'
       OR ip_address GLOB '172.3[01].*'
     );
  `
};

export default migration;

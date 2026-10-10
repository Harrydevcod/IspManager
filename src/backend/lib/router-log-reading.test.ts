import { describe, expect, test } from 'vitest';
import { compactEntries, readLog, type LogLookups } from './router-log-reading';
import type { RouterLogEntry } from './routeros';

const lookups: LogLookups = {
  apiUser: 'ispm-api',
  clientOfLogin: (login) => (login === 'skn001' ? 'Isa Rafe' : null),
  aboutMac: (mac) => (mac === '18:FD:74:22:23:B7' ? { clientName: 'Cibel Restaurante', vendor: 'TP-Link' } : { clientName: null, vendor: null })
};

const entry = (id: number, message: string, topics = 'system,info', time = '05:59:50'): RouterLogEntry =>
  ({ id: `*${id.toString(16)}`, time, topics, message });

const one = (message: string, topics = 'system,info') => readLog([entry(1, message, topics)], lookups)[0];

// Tal como o router as escreveu em 2026-10-10: a gravação das WAN vem partida em duas linhas.
const WAN_HEAD = String.raw`changed script settings by scheduler:ispm-wan-usage/script:ispm-wan-usage/action:388 (/system script set ispm-wan-usage-data policy="" source="# uptime;4d22:49:29\; \n# last;WAN1-STARLINK;1063746064429;71761961175\; \n# last;WAN2-STARLINK;0;0\; \n# 20730;WAN2-STARLINK;86752886247;7230386495\; \n# 2`;
const WAN_TAIL = String.raw`0731;WAN1-STARLINK;197577548874;16398972123\; \n# 20731;WAN2-STARLINK;13908914027;512989102\; \n# 20736;WAN2-STARLINK;0;0\; \n")`;
const CLIENT = String.raw`changed script settings by scheduler:ispm-client-usage/script:ispm-client-usage/action:387 (/system script set ispm-client-usage-data policy="" source="# skn001;4390258995;69877721454;134679287;1334068966;03:21:00\; \n# skn014;608987415;6750174114;519232251;4881540663;07:32:54\; \n")`;

describe('gravações dos contadores', () => {
  test('a gravação partida em fragmentos fica numa linha só, de manutenção', () => {
    // O registo ao vivo vem do mais recente para o mais antigo.
    const read = readLog([entry(12, 'LAN1 link down', 'interface,info', '06:00:01'), entry(11, WAN_TAIL), entry(10, WAN_HEAD), entry(9, CLIENT)], lookups);
    expect(read.map((row) => [row.id, row.machine, row.text])).toEqual([
      ['*c', false, 'Porta LAN1 sem ligação'],
      ['*a', true, 'Contador das WAN gravou os totais'],
      ['*9', true, 'Contador de consumo por cliente gravou os totais']
    ]);
    expect(read[1].kind).toBe('contador');
    // A linha crua fica curta: o que aconteceu, sem os números.
    expect(read[1].message).toBe('changed script settings by scheduler:ispm-wan-usage/script:ispm-wan-usage/action:388 (/system script set ispm-wan-usage-data source=…)');
  });

  test('a ordem de entrada mantém-se, seja qual for', () => {
    const read = readLog([entry(9, CLIENT), entry(10, WAN_HEAD), entry(11, WAN_TAIL), entry(12, 'LAN1 link down', 'interface,info')], lookups);
    expect(read.map((row) => row.id)).toEqual(['*9', '*a', '*c']);
  });

  test('uma linha de outro segundo ou de outro tópico não é continuação', () => {
    const read = readLog([entry(10, WAN_HEAD), entry(11, 'LAN1 link down', 'interface,info'), entry(12, 'LAN1 link down', 'system,info', '06:10:00')], lookups);
    expect(read).toHaveLength(3);
    expect(read[0].machine).toBe(true);
  });

  test('um fragmento sem cabeça é manutenção e não se guarda', () => {
    expect(one(WAN_TAIL)).toMatchObject({ machine: true, kind: 'contador', text: 'Contador do ISPM: resto de uma gravação' });
    expect(compactEntries([entry(1, WAN_TAIL), entry(2, 'LAN1 link down', 'interface,info')]).map((row) => row.id)).toEqual(['*2']);
  });

  test('a alteração de outro script não é ruído', () => {
    const row = one('changed script settings by tcp-msg(winbox):admin@192.168.2.250 (/system script set aviso source=":log info ola")');
    expect(row.machine).toBe(false);
    expect(row.message).toContain(':log info ola');
  });

  // Medido no CHR 7.24.2: atualizar um contador regista o script novo inteiro, em pedaços.
  test('a instalação de um script e a criação do ficheiro, partidas em pedaços, ficam numa linha cada', () => {
    const read = readLog([
      entry(1, String.raw`changed script settings by api:ispm-api@::/action:2 (/system script set ispm-wan-usage comment="ispm-wan-usage v7 @sd1" policy=read,write source="# ispm-wan-usage v7\;     \n:local a [:find \$line \";\"]`),
      entry(2, String.raw`len \$line]] }\;     \n  :set x (\$a . \"b\")`),
      entry(3, String.raw`  :if (\$keep) do={ :set output \$x }")`),
      entry(4, String.raw`add file by api:ispm-api@::/script:ispm-wan-usage (*0 = /file add contents="# uptime;00:02:07\;     \n# last;ether1;27746;34913\;     \n# 20736;ether1`),
      entry(5, String.raw`;15346;17115\;     \n" name=sd1/ispm-wan-usage.txt)`),
      entry(6, 'script removed by api:ispm-api@::/script:ispm-wan-usage/action:3 (/system script remove *2)'),
      // Inteira e curta, mas com totais lá dentro: não é um resto de gravação, é o ficheiro a nascer.
      entry(7, String.raw`add file by scheduler:ispm-wan-usage/script:ispm-wan-usage (*0 = /file add contents="# uptime;00:02:24\;     \n# last;ether1;56293;124178\;     \n" name=sd1/ispm-wan-usage.txt)`)
    ], lookups);
    expect(read.map((row) => [row.id, row.text])).toEqual([
      ['*1', 'O ISPM alterou o script ispm-wan-usage'],
      ['*4', 'O ISPM criou o ficheiro sd1/ispm-wan-usage.txt'],
      ['*6', 'O ISPM removeu um script'],
      ['*7', 'O agendamento ispm-wan-usage criou o ficheiro sd1/ispm-wan-usage.txt']
    ]);
    expect(read.every((row) => !row.machine)).toBe(true);
    expect(read[0].message).toBe('changed script settings by api:ispm-api@::/action:2 (/system script set ispm-wan-usage comment="ispm-wan-usage v7 @sd1" policy=read,write source=…)');
    expect(read[1].message).toBe('add file by api:ispm-api@::/script:ispm-wan-usage (*0 = /file add contents=… name=sd1/ispm-wan-usage.txt)');
  });

  test('compactar é idempotente', () => {
    const once = compactEntries([entry(9, CLIENT), entry(10, WAN_HEAD), entry(11, WAN_TAIL)]);
    expect(compactEntries(once)).toEqual(once);
    expect(once).toHaveLength(2);
  });
});

describe('leitura das linhas', () => {
  test('as leituras do próprio ISPM são manutenção', () => {
    expect(one('user ispm-api logged in from 192.168.2.250 via rest-api', 'system,info,account')).toMatchObject({ machine: true, text: 'O ISPM ligou-se ao router' });
    expect(one('user ispm-api logged out via api', 'system,info,account')).toMatchObject({ machine: true, text: 'O ISPM desligou-se do router' });
    expect(one('user admin logged in from 192.168.2.250 via winbox', 'system,info,account')).toMatchObject({ machine: false, text: 'admin entrou a partir de 192.168.2.250 por winbox' });
  });

  test('PPPoE com o nome do cliente', () => {
    expect(one('<pppoe-skn001>: terminating... - peer is not responding', 'pppoe,ppp,info').text)
      .toBe('PPPoE skn001 (Isa Rafe): a sessão caiu — o equipamento do cliente deixou de responder');
    expect(one('<pppoe-skn001>: connected', 'pppoe,ppp,info').text).toBe('PPPoE skn001 (Isa Rafe): ligado');
    expect(one('<pppoe-skn001>: authenticated', 'pppoe,ppp,info').text).toBe('PPPoE skn001 (Isa Rafe): autenticado');
    expect(one('<pppoe-skn001>: disconnected', 'pppoe,ppp,info').text).toBe('PPPoE skn001 (Isa Rafe): sessão terminada');
    expect(one('<pppoe-skn001>: terminating...', 'pppoe,ppp,info').text).toBe('PPPoE skn001 (Isa Rafe): a sessão está a terminar');
    expect(one('<0010>: user skn014 authentication failed', 'pppoe,ppp,error').text).toBe('PPPoE skn014: autenticação falhada');
    expect(one('PPPoE connection established from 18:FD:74:22:23:B7', 'pppoe,info').text).toBe('Pedido de ligação PPPoE de 18:FD:74:22:23:B7 (Cibel Restaurante)');
    expect(one('skn001 logged in, 10.99.0.2 from 52:54:00:AA:00:03', 'pppoe,ppp,info,account').text).toBe('PPPoE skn001 (Isa Rafe): entrou com o endereço 10.99.0.2');
    expect(one('skn001 logged out, 143 115036 112418 106 92 from 52:54:00:AA:00:03', 'pppoe,ppp,info,account').text).toBe('PPPoE skn001 (Isa Rafe): saiu ao fim de 2 min 23 s');
    expect(one('skn014 logged out, 27174 1 2 3 4 from 18:FD:74:22:23:B7', 'pppoe,ppp,info,account').text).toBe('PPPoE skn014: saiu ao fim de 7 h 32 min');
    expect(one('router rebooted', 'system,info').text).toBe('O router reiniciou');
    expect(one('<pppoe-skn001> detect INTERNET', 'interface,info').text).toBe('PPPoE skn001 (Isa Rafe): deteção de Internet — com Internet');
    expect(one('WAN1-STARLINK detect UNKNOWN', 'interface,info').text).toBe('WAN1-STARLINK: deteção de Internet — por determinar');
  });

  test('DHCP, vigia das antenas, portas e logins', () => {
    expect(one('dhcp-SKYNET assigned 192.168.2.249 for 08:8A:F1:6F:4C:93 MW325R', 'dhcp,info').text).toBe('DHCP: 192.168.2.249 entregue a 08:8A:F1:6F:4C:93 (MW325R)');
    expect(one('dhcp-SKYNET deassigned 192.168.2.81 for 16:3F:61:6E:2D:81 ', 'dhcp,info').text).toBe('DHCP: 192.168.2.81 libertado por 16:3F:61:6E:2D:81');
    expect(one('LAN1: received DHCP server message on untrusted port from source IP 192.168.0.1, MAC 30:16:9d:aa:53:8b', 'bridge,warning').text)
      .toBe('Resposta DHCP na porta não confiável LAN1: 192.168.0.1, 30:16:9D:AA:53:8B');
    expect(one('dhcp-SKYNET assigned 192.168.2.230 for 3C:64:CF:7B:80:08 Archer C20', 'dhcp,info').text).toBe('DHCP: 192.168.2.230 entregue a 3C:64:CF:7B:80:08 (Archer C20)');
    expect(one('dhcp-SKYNET offering lease 192.168.2.118 for 18:FD:74:22:23:B7 without success', 'dhcp,warning').text)
      .toBe('DHCP: 192.168.2.118 oferecido a 18:FD:74:22:23:B7 (Cibel Restaurante) sem resposta');
    expect(one('client1 on WAN1-STARLINK lost IP address 100.64.0.2 - lease stopped locally', 'dhcp,info').text).toBe('WAN1-STARLINK perdeu o endereço 100.64.0.2');
    expect(one('client1 on WAN1-STARLINK got IP address 100.64.0.2', 'dhcp,info').text).toBe('WAN1-STARLINK recebeu o endereço 100.64.0.2');
    expect(one('event down [ type: simple, host: 192.168.1.110 ]', 'netwatch,info').text).toBe('192.168.1.110 deixou de responder');
    expect(one('event up [ type: simple, host: 192.168.1.110 ]', 'netwatch,info').text).toBe('192.168.1.110 voltou a responder');
    expect(one('WAN1-STARLINK link up (speed 1G, full duplex)', 'interface,info').text).toBe('Porta WAN1-STARLINK com ligação (1G, full duplex)');
    expect(one('login failure for user admin from 5C:80:B6:E8:74:DE via winbox', 'system,error,critical').text)
      .toBe('Login falhado do utilizador admin a partir de 5C:80:B6:E8:74:DE por winbox');
  });

  test('alterações de configuração dizem quem e o quê', () => {
    expect(one('ppp secret <skn001> changed by api:ispm-api@::/action:243 (/ppp secret set skn001 profile=PLANO-20-20)').text)
      .toBe('O ISPM alterou o acesso PPPoE skn001 (Isa Rafe): profile=PLANO-20-20');
    expect(one('ppp secret <skn014> changed by mac-msg(winbox):admin@54:14:A7:11:53:3C/terminal/action:245 (/ppp secret set skn014 profile=PLANO-40-10)').text)
      .toBe('admin (WinBox) alterou o acesso PPPoE skn014: profile=PLANO-40-10');
    expect(one('Netwatch config removed by tcp-msg(winbox):admin@192.168.2.250/terminal/action:133 (/tool netwatch remove *1)').text)
      .toBe('admin (WinBox) removeu uma vigia netwatch');
    expect(one('log rule added by api:ispm-api@:: (*F = /system logging add action=ispmdiario topics=info,!account)').text)
      .toBe('O ISPM criou uma regra de registo: action=ispmdiario topics=info,!account');
    expect(one('add file by mac-msg(winbox):admin@54:14:A7:11:53:3C/terminal (*0 = /file add contents="a;1;2" name=sd1/ispm-teste.txt)').text)
      .toBe('admin (WinBox) criou o ficheiro sd1/ispm-teste.txt');
    expect(one('new script added by api:ispm-api@:: (*5 = /system script add name=ispm-wan-usage policy=read,write source="# x")').text)
      .toBe('O ISPM criou o script ispm-wan-usage');
    expect(one('new script scheduled by mac-msg(winbox):admin@54:14:A7:11:53:3C/terminal (*4 = /system scheduler add interval=10s name=ispm-teste on-event=ispm-teste policy=read,write)').text)
      .toBe('admin (WinBox) criou o agendamento ispm-teste');
    expect(one('log action changed by tcp-msg(winbox):admin@192.168.2.250/terminal/action:132 ()').text).toBe('admin (WinBox) alterou uma ação de registo');
    expect(one('ppp profile <PLANO-20-10> added by api:ispm-api@:: (*4 = /ppp profile add comment=ispm:plano:1 name=PLANO-20-10)').text)
      .toBe('O ISPM criou o perfil PPP PLANO-20-10: comment=ispm:plano:1 name=PLANO-20-10');
  });

  test('o que não tem regra passa tal como o router o escreveu', () => {
    expect(one('ANTENA EM BAIXO: CPE710 Espia', 'script,warning')).toMatchObject({ text: 'ANTENA EM BAIXO: CPE710 Espia', kind: 'outro', machine: false });
  });
});

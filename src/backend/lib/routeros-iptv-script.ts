import { createHash } from 'node:crypto';
import { isMacAddress } from '../../shared/mac';
import { rosQuote } from './routeros';

export const IPTV_SCRIPT_NAME = 'ispm-iptv';
export const IPTV_SCRIPT_VERSION = 'ispm-iptv v1';

const USERNAME = /^[\w.@-]{1,64}$/;
const LIST = /^[\w.-]{1,64}$/;

/** Versão e resumo do conteúdo: mudar a lista de clientes reinstala o script, nada mais o faz. */
export const iptvScriptMark = (source: string) =>
  `${IPTV_SCRIPT_VERSION} #${createHash('sha256').update(source).digest('hex').slice(0, 8)}`;

/**
 * O script que mantém na lista as origens dos serviços com IPTV via VPN (ADR 0021).
 * Só toca em entradas `ispm-iptv:*`, sempre dinâmicas: ficam em RAM e um reinício
 * limpa-as, e é o agendamento de arranque que as refaz. Um endereço que já esteja
 * numa entrada manual não se duplica (o ISPM reporta o conflito; o script não escreve no registo).
 */
export function iptvSplitScript({ list, users, macs }: { list: string; users: string[]; macs: string[] }): string {
  if (!LIST.test(list)) throw new Error('Nome de lista inválido');
  for (const user of users) if (!USERNAME.test(user)) throw new Error(`Utilizador PPPoE inválido: ${user}`);
  for (const mac of macs) if (!isMacAddress(mac)) throw new Error(`MAC inválido: ${mac}`);
  const array = (values: string[]) => values.length ? `{${[...new Set(values)].sort().map(rosQuote).join(';')}}` : '({})';
  const L = rosQuote(list);
  return String.raw`# ${IPTV_SCRIPT_VERSION}
:local users ${array(users)}
:local macs ${array(macs)}
:local want ({})
:foreach u in=$users do={ :foreach a in=[/ppp active find where name=$u] do={
  :local ad [:tostr [/ppp active get $a address]]
  :if ($ad != "") do={ :set ($want->$ad) ("ispm-iptv:" . $u) } } }
:foreach m in=$macs do={ :foreach l in=[/ip dhcp-server lease find where mac-address=$m status=bound] do={
  :local ad [:tostr [/ip dhcp-server lease get $l address]]
  :if ($ad != "") do={ :set ($want->$ad) ("ispm-iptv:legacy:" . $m) } } }
:local keep ({})
:foreach e in=[/ip firewall address-list find where list=${L} comment~"^ispm-iptv:"] do={
  :local ad [:tostr [/ip firewall address-list get $e address]]
  :if (($want->$ad) = [/ip firewall address-list get $e comment]) do={ :set ($keep->$ad) true } else={ /ip firewall address-list remove $e } }
:foreach ad,c in=$want do={ :if ([:typeof ($keep->$ad)] = "nothing") do={
  :if ([:len [/ip firewall address-list find where list=${L} address=$ad]] = 0) do={ :do { /ip firewall address-list add list=${L} address=$ad comment=$c dynamic=yes } on-error={} } } }
`;
}

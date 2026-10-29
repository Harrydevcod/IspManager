export const DROP_CAPTURE_SCRIPT_NAME = 'ispm-queda';
export const DROP_CAPTURE_SCRIPT_VERSION = 'ispm-queda v1';
/** O que o script escreve no registo; é por isto que a Saúde da rede o encontra. */
export const DROP_CAPTURE_PREFIX = 'ispm-queda:';
// O comentário do agendamento enquanto dura uma queda em bloco.
const DROP_CAPTURE_STATE = 'em-queda';

/**
 * O retrato da rede no instante em que várias antenas do netwatch caem juntas.
 *
 * As quedas em bloco de 10/2026 duravam de 27 s a 10 min e ninguém estava ao router para ver o
 * que mudava: o MAC que responde pelo endereço de cada antena, o estado do ARP e a porta onde
 * a bridge a aprendeu. O script corre de 10 em 10 s, escreve uma linha por antena caída no
 * início de cada queda em bloco (2 ou mais) e uma no fim. Não toca no netwatch do operador,
 * que é dele: só escreve no comentário do próprio agendamento.
 *
 * Medido no CHR 7.24.2:
 * - `find where … disabled=no` não encontra nada no netwatch; só `!disabled`.
 * - Um script corrido pelo agendamento só guarda uma `:global` entre corridas com políticas
 *   como `policy` ou `sensitive`. Em vez de as dar, o "já escrevi" fica no comentário do próprio
 *   agendamento: uma escrita no início e outra no fim de cada queda. O `ensureRouterScript` não
 *   compara esse campo, por isso não o desfaz.
 */
export function dropCaptureScript(): string {
  const p = DROP_CAPTURE_PREFIX;
  return String.raw`# ${DROP_CAPTURE_SCRIPT_VERSION}
:local me [/system scheduler find where name="${DROP_CAPTURE_SCRIPT_NAME}"]
:if ([:len $me] = 0) do={ :error "sem agendamento" }
:local was ([/system scheduler get $me comment] = "${DROP_CAPTURE_STATE}")
:local down [/tool netwatch find where status="down" !disabled]
:if ([:len $down] < 2) do={
  :if ($was) do={ :log info "${p} fim"; /system scheduler set $me comment="" }
} else={ :if (!$was) do={
  /system scheduler set $me comment="${DROP_CAPTURE_STATE}"
  :foreach n in=$down do={
    :local h [:tostr [/tool netwatch get $n host]]
    :local mac "-"
    :local st "-"
    :local port "-"
    :foreach a in=[/ip arp find where address=$h] do={
      :set mac [:tostr [/ip arp get $a mac-address]]
      :set st [:tostr [/ip arp get $a status]] }
    :if ($mac != "-" && $mac != "") do={ :foreach b in=[/interface bridge host find where mac-address=$mac] do={
      :set port [:tostr [/interface bridge host get $b on-interface]] } }
    :log warning ("${p} " . $h . " mac=" . $mac . " arp=" . $st . " porta=" . $port) } } }
`;
}

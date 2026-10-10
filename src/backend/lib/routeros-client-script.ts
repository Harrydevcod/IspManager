import { loadUsageState, storeUsageState } from './routeros-usage-store';

/**
 * Contador PPPoE no MikroTik. O estado persiste num ficheiro do cartão ou, sem cartão, no
 * script `ispm-client-usage-data` (ver `routeros-usage-store.ts`).
 * As globais do scheduler não persistem e uma chave de array ausente é "nothing".
 * Sessão nova = tempo ligado a descer ou contador a descer.
 *
 * Uma sessão que cai entre duas corridas leva consigo o que passou desde a última. O router
 * escreve o total à saída — `skn001 logged out, <segundos> <rx> <tx> <pacotes> <pacotes> from
 * <MAC>`, tópico `account`, medido no CHR e no hEX S (7.24.2); a linha inclui os bytes do fecho.
 * Antes das sessões ativas, o script soma dessas linhas o que faltava: `total − último` se é a
 * sessão que já tinha visto (durou pelo menos o tempo guardado), o total inteiro se nasceu e
 * morreu entre corridas; depois zera o `último`, e a sessão seguinte conta do zero.
 * A linha `@log;<id> <hora>` do estado é a última saída tratada. Na primeira corrida não há
 * marca e as saídas antigas ficam por tratar: já foram contadas, por alto, pelas leituras.
 * ponytail: lê-se o registo em memória (1000 linhas; o pico medido em produção foi 160 por
 * hora). Uma sessão perdida num reinício do router não deixa linha. Buffer próprio para o
 * tópico `account` se o registo passar a rodar em menos de uma hora.
 * ponytail: com a app fechada vários dias, o consumo cai no dia da reabertura;
 * o total do mês fica certo. Criar baldes diários no router se esse detalhe importar.
 */
export const CLIENT_USAGE_NAME = 'ispm-client-usage';
export const CLIENT_USAGE_VERSION = 'ispm-client-usage v3';
export const CLIENT_USAGE_DATA_NAME = 'ispm-client-usage-data';

export const clientUsageScript = (disk: string | null) => String.raw`# ${CLIENT_USAGE_VERSION}
${loadUsageState(CLIENT_USAGE_NAME, CLIENT_USAGE_DATA_NAME, disk)}
:local totals [:toarray ""]
:while ([:len $text] > 0) do={
  :local stop [:find $text "\n"]
  :if ([:typeof $stop] = "nil") do={ :set stop [:len $text] }
  :local line [:pick $text 0 $stop]
  :set text [:pick $text ($stop + 1) [:len $text]]
  :if ([:pick $line 0 2] = "# ") do={ :set line [:pick $line 2 [:len $line]] }
  :local separator [:find $line ";"]
  :if ([:typeof $separator] != "nil") do={
    :local name [:pick $line 0 $separator]
    :if ([:len $name] > 0) do={ :set ($totals->$name) [:pick $line ($separator + 1) [:len $line]] }
  }
}
:local mark ($totals->"@log")
:local outs [/log find where buffer=memory topics~"account" message~"^[^ ]+ logged out, [0-9]"]
:local pending [:toarray ""]
:local newest "-"
:local found false
:foreach id in=$outs do={
  :set newest ($id . " " . [/log get $id time])
  :if ($found) do={ :set pending ($pending, $id) }
  :if ($newest = $mark) do={ :set found true }
}
:if ([:typeof $mark] != "str") do={ :set found true }
:if (!$found) do={ :set pending $outs }
:foreach id in=$pending do={
  :local message [/log get $id message]
  :local cut [:find $message " logged out, "]
  :local name [:pick $message 0 $cut]
  :local rest [:pick $message ($cut + 13) [:len $message]]
  :local a [:find $rest " "]
  :local b [:find $rest " " ($a + 1)]
  :local c [:find $rest " " ($b + 1)]
  :if ([:typeof $c] != "nil") do={
    :local seconds [:pick $rest 0 $a]
    :local rx [:tonum [:pick $rest ($a + 1) $b]]
    :local tx [:tonum [:pick $rest ($b + 1) $c]]
    :local sumRx 0
    :local sumTx 0
    :local oldRx 0
    :local oldTx 0
    :local oldUptime "00:00:00"
    :local previous ($totals->$name)
    :if ([:typeof $previous] = "str") do={
      :local p [:find $previous ";"]
      :local q [:find $previous ";" ($p + 1)]
      :local r [:find $previous ";" ($q + 1)]
      :local s [:find $previous ";" ($r + 1)]
      :if ([:typeof $s] != "nil") do={
        :set sumRx [:tonum [:pick $previous 0 $p]]
        :set sumTx [:tonum [:pick $previous ($p + 1) $q]]
        :set oldRx [:tonum [:pick $previous ($q + 1) $r]]
        :set oldTx [:tonum [:pick $previous ($r + 1) $s]]
        :set oldUptime [:pick $previous ($s + 1) [:len $previous]]
      }
    }
    :local seen ([:totime ($seconds . "s")] >= [:totime $oldUptime])
    :if ($seen && ($rx >= $oldRx)) do={ :set sumRx ($sumRx + $rx - $oldRx) } else={ :set sumRx ($sumRx + $rx) }
    :if ($seen && ($tx >= $oldTx)) do={ :set sumTx ($sumTx + $tx - $oldTx) } else={ :set sumTx ($sumTx + $tx) }
    :set ($totals->$name) ($sumRx . ";" . $sumTx . ";0;0;00:00:00")
  }
}
:set ($totals->"@log") $newest
:foreach session in=[/ppp active find] do={
  :local name [/ppp active get $session name]
  :local uptime [/ppp active get $session uptime]
  :local ifaceName ("<pppoe-" . $name . ">")
  :local ids [/interface find where name=$ifaceName]
  :if ([:len $ids] > 0) do={
    :local rx [:tonum [/interface get $ids rx-byte]]
    :local tx [:tonum [/interface get $ids tx-byte]]
    :local sumRx 0
    :local sumTx 0
    :local previous ($totals->$name)
    :if ([:typeof $previous] = "str") do={
      :local a [:find $previous ";"]
      :local b [:find $previous ";" ($a + 1)]
      :local c [:find $previous ";" ($b + 1)]
      :local d [:find $previous ";" ($c + 1)]
      :if ([:typeof $d] != "nil") do={
        :set sumRx [:tonum [:pick $previous 0 $a]]
        :set sumTx [:tonum [:pick $previous ($a + 1) $b]]
        :local oldRx [:tonum [:pick $previous ($b + 1) $c]]
        :local oldTx [:tonum [:pick $previous ($c + 1) $d]]
        :local oldUptime [:pick $previous ($d + 1) [:len $previous]]
        :local fresh ([:totime $uptime] < [:totime $oldUptime])
        :if ($fresh || ($rx < $oldRx)) do={ :set sumRx ($sumRx + $rx) } else={ :set sumRx ($sumRx + $rx - $oldRx) }
        :if ($fresh || ($tx < $oldTx)) do={ :set sumTx ($sumTx + $tx) } else={ :set sumTx ($sumTx + $tx - $oldTx) }
      }
    }
    :set ($totals->$name) ($sumRx . ";" . $sumTx . ";" . $rx . ";" . $tx . ";" . $uptime)
  }
}
:local output ""
:foreach name,value in=$totals do={ :set output ($output . "# " . $name . ";" . $value . "\n") }
${storeUsageState('dados do ispm-client-usage; nao editar')}`;

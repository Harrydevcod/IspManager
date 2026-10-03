/**
 * Contador PPPoE no MikroTik. O estado persiste nos comentários do segundo script.
 * As globais do scheduler não persistem e uma chave de array ausente é "nothing".
 * Sessão nova = tempo ligado a descer ou contador a descer. ponytail: uma sessão que cai e
 * volta já com mais tempo ligado e mais bytes do que a anterior tinha na última gravação passa
 * por continuação e perde esses bytes (minutos de tráfego); gravar a hora da corrida se pesar.
 * ponytail: com a app fechada vários dias, o consumo cai no dia da reabertura;
 * o total do mês fica certo. Criar baldes diários no router se esse detalhe importar.
 */
export const CLIENT_USAGE_DATA_NAME = 'ispm-client-usage-data';

export const CLIENT_USAGE_SCRIPT = String.raw`# ispm-client-usage v1
:local dataName "ispm-client-usage-data"
:local totals [:toarray ""]
:local dataIds [/system script find where name=$dataName]
:if ([:len $dataIds] > 0) do={
  :local text [/system script get $dataIds source]
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
}
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
:if ([:len $dataIds] = 0) do={
  /system script add name=$dataName policy=read comment="dados do ispm-client-usage; nao editar" source=$output
} else={
  /system script set $dataIds source=$output
}`;

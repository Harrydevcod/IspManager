/**
 * Contador das WAN que corre no próprio MikroTik.
 * Todo o estado vive como comentários no script `ispm-wan-usage-data` (só precisa de
 * read,write e sobrevive a reinícios):
 *   # 2026-09-29;WAN1;rx;tx   totais do dia (últimos 31 dias)
 *   # last;WAN1;rx;tx         contador visto na corrida anterior
 *   # uptime;1d02:03:04       tempo ligado na corrida anterior
 * Medido no hAP: as globais do scheduler não passam de uma corrida para a outra, por isso
 * não se usam. Tempo ligado a descer = o router reiniciou e os contadores voltaram a zero.
 * Posição de array inexistente tem tipo "nothing" (não "nil", que é o do :find sem
 * resultado): os valores testam-se pelo tipo esperado.
 * Corre de hora a hora às hh:59:50 (e no arranque): cada gravação deixa uma entrada longa no
 * registo do router, e de 5 em 5 min enchia-o em menos de um dia. O dia fecha a 10 s da meia-noite;
 * num corte de luz perde-se no máximo a última hora. O ISPM aberto soma a hoje o que falta.
 */
export const WAN_USAGE_DATA_NAME = 'ispm-wan-usage-data';

export const WAN_USAGE_SCRIPT = String.raw`# ispm-wan-usage v5
:local dataName "ispm-wan-usage-data"
:local totals [:toarray ""]
:local last [:toarray ""]
:local lastUptime ""
:local dataIds [/system script find where name=$dataName]
:if ([:len $dataIds] > 0) do={
  :local text [/system script get $dataIds source]
  :while ([:len $text] > 0) do={
    :local stop [:find $text "\n"]
    :if ([:typeof $stop] = "nil") do={ :set stop [:len $text] }
    :local line [:pick $text 0 $stop]
    :set text [:pick $text ($stop + 1) [:len $text]]
    :if ([:pick $line 0 2] = "# ") do={ :set line [:pick $line 2 [:len $line]] }
    :local a [:find $line ";"]
    :if ([:typeof $a] != "nil") do={
      :local head [:pick $line 0 $a]
      :local rest [:pick $line ($a + 1) [:len $line]]
      :if ($head = "uptime") do={ :set lastUptime $rest } else={
        :local b [:find $rest ";"]
        :if ([:typeof $b] != "nil") do={
          :if ($head = "last") do={
            :set ($last->[:pick $rest 0 $b]) [:pick $rest ($b + 1) [:len $rest]]
          } else={
            :set ($totals->($head . ";" . [:pick $rest 0 $b])) [:pick $rest ($b + 1) [:len $rest]]
          }
        }
      }
    }
  }
}
:local uptime [/system resource get uptime]
:local rebooted false
:if ([:len $lastUptime] > 0) do={
  :if ([:totime $lastUptime] > $uptime) do={ :set rebooted true }
}
:local rawDate [/system clock get date]
:local day $rawDate
:if ([:pick $rawDate 3 4] = "/") do={
  :local months {jan="01";feb="02";mar="03";apr="04";may="05";jun="06";jul="07";aug="08";sep="09";oct="10";nov="11";dec="12"}
  :set day ([:pick $rawDate 7 11] . "-" . ($months->[:pick $rawDate 0 3]) . "-" . [:pick $rawDate 4 6])
}
:local seen [:toarray ""]
:foreach member in=[/interface list member find where list="WAN"] do={
  :local iface [/interface list member get $member interface]
  :local ids [/interface find where name=$iface]
  :if ([:len $ids] > 0) do={
    :local rx [:tonum [/interface get $ids rx-byte]]
    :local tx [:tonum [/interface get $ids tx-byte]]
    :local drx 0
    :local dtx 0
    :local previous ($last->$iface)
    :if ([:typeof $previous] = "str") do={
      :local s [:find $previous ";"]
      :local oldRx [:tonum [:pick $previous 0 $s]]
      :local oldTx [:tonum [:pick $previous ($s + 1) [:len $previous]]]
      :if ($rebooted || ($rx < $oldRx)) do={ :set drx $rx } else={ :set drx ($rx - $oldRx) }
      :if ($rebooted || ($tx < $oldTx)) do={ :set dtx $tx } else={ :set dtx ($tx - $oldTx) }
    }
    :set ($seen->$iface) ($rx . ";" . $tx)
    :local key ($day . ";" . $iface)
    :local sumRx $drx
    :local sumTx $dtx
    :local total ($totals->$key)
    :if ([:typeof $total] = "str") do={
      :local s [:find $total ";"]
      :set sumRx ($sumRx + [:tonum [:pick $total 0 $s]])
      :set sumTx ($sumTx + [:tonum [:pick $total ($s + 1) [:len $total]]])
    }
    :set ($totals->$key) ($sumRx . ";" . $sumTx)
  }
}
:local days [:toarray ""]
:foreach key,value in=$totals do={ :set ($days->[:pick $key 0 10]) 1 }
:local skip ([:len $days] - 31)
:local oldDays [:toarray ""]
:foreach d,ignored in=$days do={
  :if ($skip > 0) do={ :set ($oldDays->$d) 1; :set skip ($skip - 1) }
}
:local output ("# uptime;" . $uptime . "\n")
:foreach iface,value in=$seen do={ :set output ($output . "# last;" . $iface . ";" . $value . "\n") }
:foreach key,value in=$totals do={
  :if ([:typeof ($oldDays->[:pick $key 0 10])] != "num") do={
    :set output ($output . "# " . $key . ";" . $value . "\n")
  }
}
:if ([:len $dataIds] = 0) do={
  /system script add name=$dataName policy=read comment="dados do ispm-wan-usage; nao editar" source=$output
} else={
  /system script set $dataIds source=$output
}`;

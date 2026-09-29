/** Written every five minutes. Raise the scheduler interval to 15m if flash wear matters. */
export const WAN_USAGE_SCRIPT = String.raw`# ispm-wan-usage v1
# Escreve a cada 5 min; subir para 15 min se o desgaste da flash preocupar.
:global ispmWanLast
:global ispmWanTotals
:if ([:typeof $ispmWanLast] != "array") do={ :set ispmWanLast [:toarray ""] }
:local fileName "ispm-wan-usage.txt"
:if ([:len [/file find where name="flash"]] > 0) do={ :set fileName "flash/ispm-wan-usage.txt" }
:if ([:typeof $ispmWanTotals] != "array") do={
  :set ispmWanTotals [:toarray ""]
  :local files [/file find where name=$fileName]
  :if ([:len $files] > 0) do={
    :local text [/file get $files contents]
    :while ([:len $text] > 0) do={
      :local end [:find $text "\n"]
      :if ([:typeof $end] = "nil") do={ :set end [:len $text] }
      :local line [:pick $text 0 $end]
      :set text [:pick $text ($end + 1) [:len $text]]
      :local a [:find $line ";"]
      :if ([:typeof $a] != "nil") do={
        :local b [:find $line ";" ($a + 1)]
        :local c [:find $line ";" ($b + 1)]
        :if (([:typeof $b] != "nil") && ([:typeof $c] != "nil")) do={
          :local key [:pick $line 0 $b]
          :set ($ispmWanTotals->$key) [:pick $line ($b + 1) [:len $line]]
        }
      }
    }
  }
}
:local rawDate [/system clock get date]
:local day $rawDate
:if ([:pick $rawDate 4 5] = "/") do={
  :local months {jan="01";feb="02";mar="03";apr="04";may="05";jun="06";jul="07";aug="08";sep="09";oct="10";nov="11";dec="12"}
  :local month ($months->[:pick $rawDate 0 3])
  :local number [:pick $rawDate 4 6]
  :set day ([:pick $rawDate 7 11] . "-" . $month . "-" . $number)
}
:foreach member in=[/interface list member find where list="WAN"] do={
  :local name [/interface list member get $member interface]
  :local ids [/interface find where name=$name]
  :if ([:len $ids] > 0) do={
    :local rx [:tonum [/interface get $ids rx-byte]]
    :local tx [:tonum [/interface get $ids tx-byte]]
    :local previous ($ispmWanLast->$name)
    :local drx $rx
    :local dtx $tx
    :if ([:typeof $previous] != "nil") do={
      :local separator [:find $previous ";"]
      :local oldRx [:tonum [:pick $previous 0 $separator]]
      :local oldTx [:tonum [:pick $previous ($separator + 1) [:len $previous]]]
      :if ($rx >= $oldRx) do={ :set drx ($rx - $oldRx) }
      :if ($tx >= $oldTx) do={ :set dtx ($tx - $oldTx) }
    }
    :set ($ispmWanLast->$name) ($rx . ";" . $tx)
    :local key ($day . ";" . $name)
    :local total ($ispmWanTotals->$key)
    :local oldTotalRx 0
    :local oldTotalTx 0
    :if ([:typeof $total] != "nil") do={
      :local separator [:find $total ";"]
      :set oldTotalRx [:tonum [:pick $total 0 $separator]]
      :set oldTotalTx [:tonum [:pick $total ($separator + 1) [:len $total]]]
    }
    :set ($ispmWanTotals->$key) (($oldTotalRx + $drx) . ";" . ($oldTotalTx + $dtx))
  }
}
:local days [:toarray ""]
:foreach key,value in=$ispmWanTotals do={ :set ($days->[:pick $key 0 10]) true }
:while ([:len $days] > 31) do={
  :local oldest ""
  :local oldestNumber 99999999
  :foreach date,ignored in=$days do={
    :local number [:tonum ([:pick $date 0 4] . [:pick $date 5 7] . [:pick $date 8 10])]
    :if ($number < $oldestNumber) do={ :set oldest $date; :set oldestNumber $number }
  }
  :local removeKeys [:toarray ""]
  :foreach key,ignored in=$ispmWanTotals do={
    :if ([:pick $key 0 10] = $oldest) do={ :set ($removeKeys->$key) true }
  }
  :foreach key,ignored in=$removeKeys do={ :set ($ispmWanTotals->$key) }
  :set ($days->$oldest)
}
:local output ""
:foreach key,value in=$ispmWanTotals do={ :set output ($output . $key . ";" . $value . "\n") }
:local files [/file find where name=$fileName]
:if ([:len $files] = 0) do={ /file add name=$fileName; :set files [/file find where name=$fileName] }
/file set $files contents=$output`;

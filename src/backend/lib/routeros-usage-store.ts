/**
 * Onde os contadores do router guardam o estado entre corridas (as globais do scheduler não
 * passam de uma corrida para a outra).
 *
 * Num ficheiro do disco amovível, quando o router tem um. Medido no hEX S (7.24, 2026-10-10):
 * um script com `read,write` corrido pelo scheduler faz `/file set … contents=` e o registo não
 * ganha linha nenhuma; a documentação pede `ftp`, mas só para criar o ficheiro com
 * `/file print file=`. Sem disco, ou se a escrita falhar, o estado fica como comentários no
 * `source` de um script de dados — funciona em qualquer router, mas cada gravação despeja o
 * texto inteiro no registo e escreve na flash.
 *
 * O disco confirma-se a cada corrida (`/file find … type="disk"`). Medido no CHR 7.24.2: um
 * `/file add` para um disco que não está montado não dá erro — cria uma pasta com esse nome no
 * armazenamento interno e escreve lá. Com o cartão tirado, o estado tem de voltar ao script.
 *
 * O script de dados, quando existe, é sempre o mais recente: só existe enquanto o ficheiro não
 * serve, e sai assim que uma gravação no ficheiro corre bem. Por isso lê-se primeiro.
 */

// O `/file get` e o `/file set` servem até 60 kB; acima de metade disso fica no script.
const FILE_LIMIT = 30_000;

/** O ficheiro de um contador no disco; `null` sem disco. */
export function usageDataFile(disk: string | null, name: string): string | null {
  return disk ? `${disk}/${name}.txt` : null;
}

/** Cabeça do script: deixa em `$text` o estado da corrida anterior. `name` é o do contador. */
export function loadUsageState(name: string, dataName: string, disk: string | null): string {
  const mounted = disk
    ? `\n:if ([:len [/file find where name="${disk}" type="disk"]] > 0) do={ :set dataFile "${usageDataFile(disk, name)}" }`
    : '';
  return String.raw`:local dataName "${dataName}"
:local dataFile ""${mounted}
:local text ""
:local dataIds [/system script find where name=$dataName]
:if ([:len $dataIds] > 0) do={ :set text [/system script get $dataIds source] } else={
  :if ([:len $dataFile] > 0) do={ :do { :set text [/file get $dataFile contents] } on-error={} }
}`;
}

/** Cauda do script: grava `$output`. `label` é o comentário do script de dados. */
export function storeUsageState(label: string): string {
  return String.raw`:local stored false
:if (([:len $dataFile] > 0) && ([:len $output] < ${FILE_LIMIT})) do={
  :do {
    :if ([:len [/file find where name=$dataFile]] = 0) do={
      /file add name=$dataFile contents=$output
    } else={
      /file set $dataFile contents=$output
    }
    :set stored true
  } on-error={}
}
:if ($stored) do={
  :if ([:len $dataIds] > 0) do={ /system script remove $dataIds }
} else={
  :if ([:len $dataIds] = 0) do={
    /system script add name=$dataName policy=read comment="${label}" source=$output
  } else={
    /system script set $dataIds source=$output
  }
}`;
}

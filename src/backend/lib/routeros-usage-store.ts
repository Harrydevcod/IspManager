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
 *
 * Por isso também nunca se cria logo a seguir ao arranque. Medido no hEX S a 2026-10-13 (reinício
 * da atualização): a corrida de arranque, aos 16 s, ainda não via o `sd1`, gravou um estado vazio
 * no script de dados, e a corrida seguinte passou-o por cima do ficheiro, levando os totais do
 * dia e o histórico. Com disco previsto, nos primeiros 10 minutos ligado sem ele não se grava
 * nada: a corrida seguinte lê o ficheiro, vê o reinício pelo tempo ligado e soma desde o arranque.
 *
 * Medido no hEX S a 2026-11-02 (corte de luz às ~15:00, de volta às 18:47): o ficheiro das WAN
 * voltou só com o que passou depois do arranque — sem o total do dia até ao corte nem os 30 dias
 * de histórico. Um corte a meio do `/file set` deixa o ficheiro cortado, e uma leitura falhada
 * dava estado vazio, que a corrida gravava por cima. Por isso:
 * - grava-se a cópia (`.bak.txt`) e só depois o principal: um corte a meio deixa sempre um dos
 *   dois inteiro;
 * - cada gravação acaba em `# fim`; um ficheiro sem essa linha está cortado e lê-se a cópia;
 * - um ficheiro que existe e não se lê pára a corrida sem gravar nada.
 * Um ficheiro sem `# fim` e sem cópia é de uma versão anterior e lê-se como está.
 */

// O `/file get` e o `/file set` servem até 60 kB; acima de metade disso fica no script.
const FILE_LIMIT = 30_000;

/** Última linha de cada gravação; sem ela o ficheiro ficou cortado. */
export const USAGE_STATE_END = '# fim';

/** O ficheiro de um contador no disco; `null` sem disco. */
export function usageDataFile(disk: string | null, name: string): string | null {
  return disk ? `${disk}/${name}.txt` : null;
}

/** A cópia do ficheiro, gravada antes dele. */
export function usageBackupFile(disk: string | null, name: string): string | null {
  return disk ? `${disk}/${name}.bak.txt` : null;
}

/** Cabeça do script: deixa em `$text` o estado da corrida anterior. `name` é o do contador. */
export function loadUsageState(name: string, dataName: string, disk: string | null): string {
  const mounted = disk
    ? `\n:if ([:len [/file find where name="${disk}" type="disk"]] > 0) do={ :set dataFile "${usageDataFile(disk, name)}"; :set backFile "${usageBackupFile(disk, name)}" }`
    : '';
  return String.raw`:local dataName "${dataName}"
:local diskWanted ${disk ? 'true' : 'false'}
:local dataFile ""
:local backFile ""${mounted}
:local text ""
:local dataIds [/system script find where name=$dataName]
:if ([:len $dataIds] > 0) do={ :set text [/system script get $dataIds source] } else={
  :if ([:len $dataFile] > 0) do={
    :local main ""
    :local back ""
    :local hasMain ([:len [/file find where name=$dataFile]] > 0)
    :local hasBack ([:len [/file find where name=$backFile]] > 0)
    :local unreadable false
    :if ($hasMain) do={ :do { :set main [/file get $dataFile contents] } on-error={ :set unreadable true } }
    :if ($hasBack) do={ :do { :set back [/file get $backFile contents] } on-error={ :set unreadable true } }
    :if ($unreadable) do={
      :log warning "${name}: estado ilegivel no disco, corrida sem gravar"
      :error "estado ilegivel"
    }
    :if ([:typeof [:find $main "${USAGE_STATE_END}"]] != "nil") do={ :set text $main } else={
      :if ([:typeof [:find $back "${USAGE_STATE_END}"]] != "nil") do={ :set text $back } else={
        :if (!$hasBack) do={ :set text $main }
      }
    }
  }
}`;
}

/** Grava `$output` num ficheiro, criando-o se faltar. */
const writeFile = (variable: string) => String.raw`    :if ([:len [/file find where name=${variable}]] = 0) do={
      /file add name=${variable} contents=$output
    } else={
      /file set ${variable} contents=$output
    }`;

/** Cauda do script: grava `$output`. `label` é o comentário do script de dados. */
export function storeUsageState(label: string): string {
  return String.raw`:set output ($output . "${USAGE_STATE_END}\n")
:local stored false
:if (([:len $dataFile] > 0) && ([:len $output] < ${FILE_LIMIT})) do={
  :do {
${writeFile('$backFile')}
${writeFile('$dataFile')}
    :set stored true
  } on-error={}
}
:if ($stored) do={
  :if ([:len $dataIds] > 0) do={ /system script remove $dataIds }
} else={
  :if ([:len $dataIds] = 0) do={
    :if (!$diskWanted || ([/system resource get uptime] >= [:totime "00:10:00"])) do={
      /system script add name=$dataName policy=read comment="${label}" source=$output
    }
  } else={
    /system script set $dataIds source=$output
  }
}`;
}

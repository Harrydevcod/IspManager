# ADR 0015: Os contadores do router gravam num ficheiro, não no `source` de um script

## Estado

Aceite. Implementado em `lib/routeros-usage-store.ts`, nos dois scripts (`ispm-wan-usage` v7,
`ispm-client-usage` v2) e em `lib/usage-counter.ts`. A escrita em ficheiro foi medida no router
real (hEX S); tudo o resto num RouterOS CHR 7.24.2 local, com o código de instalação do ISPM a
correr contra ele como `ispm-api` (`.scratch/chr-lab.cts`). Falta vê-lo no router de produção.

## Contexto

Os contadores das WAN e do consumo por cliente correm no MikroTik de hora a hora e precisam de
guardar o estado entre corridas (as globais do scheduler não passam de uma para a outra).
Guardavam-no como comentários no `source` de um script de dados (`…-data`).

Um `source` é configuração. Cada gravação fazia o RouterOS registar
`changed script settings … source="…"` com o texto inteiro (~1,5 kB nas WAN), partido em várias
linhas do registo em memória; ia também para o diário no cartão e para a flash interna.

## Decisões

- **Com disco amovível, o estado vai para um ficheiro** (`<disco>/ispm-wan-usage.txt`,
  `<disco>/ispm-client-usage.txt`). Medido no hEX S (RouterOS 7.24, 2026-10-10): um script com
  `read,write` corrido pelo scheduler faz `/file set … contents=` e o registo não ganha linha
  nenhuma. A documentação da MikroTik pede a política `ftp` para scripts que criam ficheiros com
  `/file print file=`; para escrever num ficheiro não foi precisa. O grupo `ispm` fica como está.

- **Sem disco, ou se a escrita falhar, fica no script de dados.** A flash gastava-se igual com
  um ficheiro na raiz, e o ISPM já esconde estas linhas na sua leitura do registo (PR #236). A
  escrita em ficheiro corre dentro de `:do { } on-error={ }`: um cartão cheio não pára a
  contagem.

- **O disco confirma-se a cada corrida** (`/file find where name=<disco> type="disk"`). Um
  `/file add` para um disco que não está montado não dá erro: cria uma pasta com esse nome no
  armazenamento interno e escreve lá. Sem esta confirmação, tirar o cartão punha o estado na
  flash em silêncio. Pela mesma razão, o ISPM não escolhe um disco por formatar.

- **O script de dados, quando existe, é o mais recente.** Só existe enquanto o ficheiro não
  serve, e sai na primeira gravação em ficheiro que corra bem. O script do router e o ISPM leem
  por esta ordem — é o que faz a migração (a primeira corrida herda os totais do script antigo)
  e o recuo sem perder contagem.

- **O formato das linhas não muda.** Os mesmos `# dia;interface;rx;tx`: os parsers do ISPM leem
  o ficheiro como liam o `source`.

- **Acima de 30 kB o estado fica no script.** O `/file get` e o `/file set` servem até 60 kB. As
  WAN andam pelos 3 kB; o consumo por cliente gasta ~60 bytes por acesso PPPoE.

- **Um contador já instalado atualiza-se sozinho.** O ISPM guarda o que instalou
  (`wanUsageCounter`, `clientUsageCounter` em `app_settings`: versão e disco). O trabalho da
  contagem (de minuto a minuto) reinstala o script quando a versão ficou para trás, fora do modo de ensaio, e só
  se o contador já lá estava. Nunca instala um contador que ninguém pediu.

## Consequências

- O registo do router deixa de ter uma linha longa por contador a cada hora; fica uma linha na
  criação de cada ficheiro e uma na remoção de cada script de dados, uma vez.
- O disco escolhido é o do diário do registo, se houver; senão o primeiro disco do router.
  Trocar de disco reinstala o script (o caminho vai escrito nele) e a contagem do router
  recomeça nesse disco; o que o ISPM já importou fica.
- O ISPM passa a escrever em `/file` no disco amovível, além de `/system/script` e
  `/system/scheduler`.

- Com o cartão tirado, o contador recomeça do zero no script de dados (não vê o ficheiro), e
  quando o cartão volta é esse estado que fica. O que o ISPM já importou mantém-se (a importação
  guarda o maior valor de cada dia); perde-se o que ainda não tinha sido importado nesse dia.

## Medido (CHR 7.24.2, 2026-10-10)

- Os dois scripts instalam-se válidos pelo `ispm-api` (grupo `read,write,api,rest-api`).
- A atualização a partir da v6/v1 herda os totais do script de dados, cria os ficheiros e apaga
  os scripts de dados. No registo ficam, por contador: a alteração do script (partida em
  pedaços, que o ISPM junta), a criação do ficheiro e a remoção do script de dados.
- Um agendamento com `read,write` regrava o ficheiro sem linha nenhuma no registo, e cria-o se
  não existir (uma linha).
- Um ficheiro de 32 500 bytes escreve-se pelo script e lê-se inteiro pelo `/execute`.
- O ficheiro sobrevive a um reinício e os totais continuam certos. A corrida do arranque pode
  vir antes de a interface WAN existir: a v7 guarda `last` a zero nesse caso, senão a corrida
  seguinte não somava nada (a v6 tinha este defeito).
- Com o disco desmontado, o contador volta ao script de dados e nada é escrito fora do disco; o
  ISPM continua a importar. Com o disco de volta, o script de dados sai.

- **A aplicação inteira** (backend deste ramo sobre uma cópia da base real, apontado ao CHR com
  uma sessão PPPoE `skn001` ativa): no primeiro minuto o trabalho da contagem atualizou os dois
  contadores sozinho (`counterUpdated`), o consumo herdou os totais do script antigo ao byte
  (32 622 + 24 922 = 57 544), uma sessão religada continuou a somar, e o ISPM importou o
  consumo para o serviço certo. A limpeza das linhas guardadas correu na vigia: 243 kB → 164 kB.
- O ecrã a 1225 px CSS (escala 150%): Registo ao vivo e guardado sem deslocamento horizontal, os
  filtros numa linha, tema escuro e claro.

## Limite que a medição pôs à vista (já existia na v1)

O consumo por cliente é lido de hora a hora. Se a sessão PPPoE cair entre duas leituras, o que
passou desde a última perde-se: no laboratório, 56 kB de uma sessão derrubada antes da leitura
seguinte. O router regista o total da sessão à saída (`skn001 logged out, <segundos> <bytes>
<bytes> …`, tópico `account`), o que dava para fechar esta falha; fica por fazer.

## Por medir

- A atualização no router de produção. A condição do script já foi lá confirmada
  (2026-10-10): `/file print where type=disk` mostra o `sd1`. Mostra também `flash`, que não
  entra na escolha do ISPM porque a flash interna não aparece em `/disk`.

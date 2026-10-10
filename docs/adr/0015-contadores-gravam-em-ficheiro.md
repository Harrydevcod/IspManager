# ADR 0015: Os contadores do router gravam num ficheiro, não no `source` de um script

## Estado

Aceite. Implementado em `lib/routeros-usage-store.ts`, nos dois scripts (`ispm-wan-usage` v7,
`ispm-client-usage` v2) e em `lib/usage-counter.ts`. A escrita em ficheiro foi medida no router
real; a criação do ficheiro pelo scheduler e a migração do estado antigo ainda não.

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
  escrita em ficheiro corre dentro de `:do { } on-error={ }`: um cartão tirado ou cheio não pára
  a contagem.

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

## Por medir

- `/file add` corrido pelo scheduler com `read,write` (o teste criou o ficheiro à mão, como
  `admin`). Se falhar, o `on-error` deixa o contador no script de dados, como hoje.
- O ficheiro a sobreviver a um reinício do router.

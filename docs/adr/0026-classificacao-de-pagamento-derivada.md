# 0026 — A classificação de pagamento deriva-se, não se grava

Data: 2026-11-20

## Contexto

O ISPM sabia quanto cada cliente deve hoje (`loadReceivables`, `agingBucket`),
mas não sabia o que cada cliente costuma fazer. Quem atrasou dez vezes e acabou
por pagar era indistinguível de quem nunca atrasou.

A forma óbvia de resolver isto é uma coluna `payment_score` nos clientes, um job
de recálculo e uma migração. É também a forma errada.

## Decisão

A pontuação e a letra são **função pura** das mensalidades e dos recibos, e
calculam-se a cada leitura. Nenhuma tabela, nenhuma coluna, nenhum job de
recálculo.

A fórmula vive em `src/shared/payment-score.ts` e recebe uma data de corte
(`asOf`). O SQL de `src/backend/lib/payment-behaviour.ts` só traz factos: que
mensalidades venceram e que dinheiro entrou por elas.

## Porquê

**Um valor gravado fica errado sozinho.** `payments` e `payment_receipts` são
imutáveis e datados, mas corrigem-se: anula-se uma fatura emitida por erro,
estorna-se um recibo, acerta-se a data de um pagamento que foi lançado com o dia
trocado. Cada uma dessas correções muda o passado de propósito — e deixaria uma
pontuação gravada a descrever um histórico que já não existe, até alguém se
lembrar de a recalcular.

**O `asOf` dá o histórico de graça.** "Este cliente melhorou ou piorou" é a
letra de hoje contra a letra de há 30 dias, as duas saídas da mesma função sobre
os mesmos factos. Uma tabela de instantâneos daria a mesma resposta e teria de
ser mantida.

**O custo não existe.** É SQLite local: duas consultas e uma dobra em memória,
milissegundos para a carteira inteira. É a mesma política de
`operations-status.ts` e `receivables.ts`, que também não têm cache — um valor
de há cinco minutos numa conversa de cobrança é pior do que valor nenhum.

## Consequências

- A letra não se pode usar como prova contratual de um estado passado: ela
  descreve o que os dados dizem agora, não o que diziam num dia. Se isso for
  preciso, nasce aí uma tabela de instantâneos, e com a impressão digital da
  fórmula que a produziu.
- Filtrar e ordenar por pontuação faz-se em memória, depois de carregar a
  carteira. Serve para a vista do Financeiro; uma listagem paginada no servidor
  que precise de ordenar por pontuação obrigaria a projetar o valor em SQL.
- Mexer na fórmula muda retroativamente todas as letras. É deliberado: a fórmula
  é uma regra de leitura, não um dado histórico.

## Alternativas consideradas

**Coluna `payment_score` em `clients`, atualizada nos pontos de escrita de
dinheiro.** Rejeitada: acrescenta um escritor a cada caminho de pagamento, e uma
correção feita por SQL à mão (que acontece) deixa o valor a mentir sem aviso.

**Tabela de instantâneos diária.** Rejeitada por agora: resolve a auditoria, que
ninguém pediu, ao preço de uma migração, um job e dois sítios onde a verdade
pode divergir.

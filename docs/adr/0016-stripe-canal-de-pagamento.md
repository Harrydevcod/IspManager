# ADR 0016: Stripe como mais uma via de pagamento

## Estado

Aceite e implementado. Por validar contra uma conta Stripe real (ver "Por confirmar").

## Contexto

Pediu-se integração com o Stripe Billing: webhook, subscriptions e bloqueio no MikroTik a partir dos
eventos. Três factos do ISPM mudam esse desenho:

1. **Não há endereço público.** O ISPM corre num PC; o Stripe não consegue entregar-lhe um webhook.
   O ADR 0013 já tinha recusado os webhooks da Meta pela mesma razão.
2. **Já existe um motor de faturação.** As faturas têm numeração fiscal e o corte por dívida tem
   tolerância e travas (ADR 0010). Subscriptions do Stripe criariam um segundo ciclo em paralelo.
3. **Já existe uma única porta para o router.** O estado comercial muda em `changeServiceStatus` e só
   a reconciliação escreve no MikroTik (ADR 0007).

## Decisão

O Stripe é **mais uma via de pagamento de uma fatura do ISPM**, opcional e escolhida fatura a fatura.
Não fatura, não corta e não fala com o router.

- **Ativação nas Configurações** (aba Stripe): interruptor, chave da API e conta de tesouraria de
  destino. Desligado por omissão; desligado, a opção não aparece e nada fala com o Stripe. Ligar exige
  chave e conta.
- **Escolha na ficha da fatura.** No seletor de método, "Stripe" troca o formulário do recibo por um
  link de pagamento. Nenhuma fatura ganha link sozinha.
- **O link é uma fatura avulsa no Stripe** (`send_invoice`, `auto_advance=false`) no valor do saldo;
  a página dela não expira em 24 h como uma Checkout Session. O Customer nasce na primeira fatura do
  cliente e o id fica em `clients.stripe_customer_id`. O metadata leva o id do cliente, da fatura, do
  serviço e o utilizador PPPoE.
  Antes de reutilizar o Customer, consulta-o com a chave atual. Apenas uma
  ausência ou eliminação confirmada permite criar outro; falhas de autenticação
  ou de rede não alteram a identidade guardada. A chave de idempotência da
  criação inclui um hash da credencial e a identidade substituída, evitando
  reutilizar respostas de outra conta, modo de teste ou cliente eliminado.
- **Sondagem em vez de webhook.** De 5 em 5 minutos o ISPM lê o estado de cada link vivo
  (`GET /v1/invoices/:id`). Lê-se o estado e não `/v1/events`: é idempotente, não tem cursor e não
  tem o teto de 30 dias dos eventos, por isso um PC desligado um mês recupera sozinho.
- **Pago no Stripe → `payPayment`**, a porta de sempre: recibo (método `outro`, nota com o id do
  Stripe), movimento na conta de destino, crédito do excesso e reativação do serviço cortado por
  dívida. O link passa a `paid` na mesma transação do recibo, para uma segunda passagem não o dobrar.
- **Uma dívida, um sítio para pagar.** Um índice único garante um link vivo por fatura. Se a fatura
  for paga por outra via, anulada ou mudar de saldo, a passagem anula o link no Stripe.
  Se a criação tiver parado num rascunho, elimina-o: a operação `/void` só aceita
  faturas finalizadas. A linha local só muda para `void` depois da confirmação
  remota. Ver [eliminação de rascunhos](https://docs.stripe.com/api/invoices/delete?api-version=2025-03-31.basil)
  e [anulação de faturas](https://docs.stripe.com/api/invoices/void?api-version=2025-03-31.basil).
  Se a resposta da eliminação se perder, confirma a ausência com a mesma chave
  que acabou de ler o rascunho. Um id ausente na primeira leitura não conta como
  cancelamento: também pode indicar uma chave de outra conta.
  Antes de eliminar, guarda na linha local um hash SHA-256 da chave que leu o
  rascunho (migração 0082). Após reinício, a ausência só confirma o cancelamento
  quando essa prova corresponde à chave atual e à mesma identidade de fatura.
  A prova não vai para a API nem contém a credencial. Uma troca de chave impede
  essa confirmação automática até se verificar a conta.
- **Dinheiro que não cabe fica para uma pessoa.** Se o Stripe recebeu e a fatura já estava liquidada,
  o link fica `review` com registo na auditoria; o ISPM não o aplica a outra fatura por adivinhação.
- **A chave é uma credencial do cofre** (`stripeSecretKey`, ADR 0012). Não há `.env` nem segredo de
  webhook: a autenticidade vem de ser o ISPM a chamar `api.stripe.com` por TLS.
- **Cobra-se na moeda das faturas** (`currencyCode`), nunca noutra.

- **O link vai nos avisos das faturas que o têm.** A variável `{link}` dos modelos expande para
  `Pague online: <url>` ou para nada, e só se preenche com o link aberto cujo valor ainda é o saldo.
  Os avisos não criam links nem falam com o Stripe: gerar o link continua a ser escolha na ficha.
  Vem nos modelos por omissão do WhatsApp; no SMS funciona mas não vem, porque o URL da página do
  Stripe é longo e custa vários segmentos.
- **Reembolso por botão, total, no ISPM.** Primeiro o Stripe (`POST /v1/refunds`), depois a base:
  só com o reembolso em `succeeded` se anula o recibo (`voidReceipt`), o que estorna a tesouraria e reabre
  a fatura. Tudo o que a anulação recusaria é verificado antes de pedir o reembolso, porque um
  reembolso não se desfaz. Admin e a password outra vez.
  A anulação genérica recusa recibos Stripe no domínio de pagamentos, incluindo
  os que têm reembolso pendente ou em revisão. A interface não oferece Anular.
  Enquanto o Stripe não confirma a conclusão, o recibo e a tesouraria mantêm-se
  válidos e a mensagem indica que o reembolso está à espera de confirmação.
- **A comissão é despesa.** Apurada pela transação de saldo do pagamento e convertida para a moeda
  das faturas pelo câmbio da própria cobrança. Entra em `outros`, fornecedor Stripe, paga pela conta
  de destino: o saldo dela na Tesouraria fica o líquido, como no extrato do Stripe. Num reembolso a
  comissão não volta, e a despesa fica.

`payment_method` não ganha o valor `stripe`: o CHECK dele está lançado desde a migração 0001.
"Fatura por Stripe" é ter um link em `stripe_payment_links` (migrações 0079 e 0080). A comissão vai
para `outros` pela mesma razão: as categorias de despesa têm CHECK lançado.

## O que fica de fora

- Reembolsos parciais, disputas e reembolsos feitos no painel do Stripe: exigem
  reconciliação assistida fora do fluxo automático; a anulação genérica não é
  um caminho para estornar localmente uma cobrança Stripe.
- Uma comissão que o Stripe não tenha apurado ao fim de 7 dias fica sem despesa.
- Cobrança automática por cartão guardado.
- Resolver um link `review` dentro do ISPM: vê-se na ficha, resolve-se no painel do Stripe.

## Condições operacionais

- A conta usada na validação aceita CVE em modo de teste; a ativação em produção
  depende da configuração e das condições da conta que receberá os pagamentos.
- A versão da API está fixa em `stripe.ts` e tem de ser revista quando o Stripe a retirar.

## Validação local em 12 de outubro de 2026

A recuperação de uma criação interrompida num rascunho foi exercitada com o
transporte real do ISPM, respostas HTTP simuladas e uma base SQLite isolada.
Depois de um recibo parcial de 1.000 CVE numa fatura de 2.500 CVE, tanto um novo
pedido de link como a sondagem cancelam o rascunho antigo. O link seguinte cobra
1.500 CVE; o recibo e o movimento de tesouraria existentes ficam preservados.
Os testes também cobrem recusa da eliminação, anulação de fatura finalizada e
repetição do cancelamento de uma fatura já anulada, bem como resposta de
eliminação perdida, recuperação após reinício e recusa de confirmação quando a
chave mudou. Se a prova não puder ser gravada, não se pede a eliminação remota.

A base instalada foi consultada em leitura apenas: não tem chave, ativação nem
conta de destino Stripe configuradas. Esta verificação não valida uma conta
Stripe. O roteiro para uma conta de teste e uma base isolada é:

1. Gerar um link em CVE e confirmar moeda e montante na página de pagamento.
2. Pagar com um cartão de teste e executar duas sondagens; confirmar um só recibo,
   uma entrada de tesouraria e a despesa de comissão, quando disponível.
3. Pedir um reembolso total; conservar o recibo enquanto estiver pendente e
   confirmar o estorno apenas quando o Stripe responder `succeeded`.
4. Interromper a criação após o rascunho, alterar o saldo e confirmar a
   recuperação sem uma segunda cobrança do saldo antigo.

## Validação com Stripe em modo de teste

Em 12 de outubro de 2026, a conta de teste aceitou uma fatura de 2.500 CVE.
O pagamento com cartão de teste produziu um único recibo e uma entrada de
tesouraria. A leitura por `invoice_payments` → `payment_intent` →
`balance_transaction` apurou uma comissão de 155,63 CVE, convertida da liquidação
em EUR pelo câmbio da cobrança. Sondagens repetidas não duplicaram o recibo nem
a despesa. O reembolso total terminou em `succeeded`, anulou o recibo e reabriu
a fatura; a comissão permaneceu como despesa. A evidência está em
`.scratch/stripe-sandbox-validation/report.json`.

Em 13 de outubro de 2026, a criação foi interrompida antes da finalização de
um rascunho remoto de 2.500 CVE. Após registrar um recibo parcial de 1.000 CVE,
um segundo processo retomou a mesma base isolada: eliminou o rascunho antigo
e criou uma fatura aberta de 1.500 CVE. A consulta sem prova de cancelamento
confirmou HTTP 404 para o rascunho eliminado. O recibo parcial e o saldo de
tesouraria foram preservados; repetir o pedido reutilizou o novo link. A lista
remota do cliente continha apenas a nova fatura. No fim, essa fatura foi anulada
e a sondagem confirmou o estado local. As verificações de integridade SQLite
passaram. A evidência está em `.scratch/stripe-draft-validation/report.json`.

Ambas as execuções usaram exclusivamente a chave de teste, com `livemode=false`
confirmado antes das escritas remotas, e bases sob `.scratch/`. A base instalada
não foi migrada nem configurada por estas validações. A interrupção foi injetada
no transporte; as operações de criação, consulta, eliminação e anulação usaram
a API Stripe. A perda de resposta após eliminação e a mudança de chave continuam
cobertas por respostas simuladas.

## Consequências

- Sem Internet o ISPM continua inteiro: só o link e a confirmação esperam.
- A confirmação demora até 5 minutos, mais a passagem da reconciliação.
- Com centenas de links abertos, um pedido por link deixa de servir e passa-se a `/v1/events`.

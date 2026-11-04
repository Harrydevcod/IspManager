# ADR 0019: Vinti4 por EasyLink como via principal de pagamento online

## Estado

Aceite e implementado. O formato do link vem da documentação do SISP: `https://www.vinti4.cv/easylink.aspx?id=…&token=…`.

## Contexto

O Vinti4 (rede SISP) é a rede dos cartões de Cabo Verde. Aceita cartões vinti4 a 0,70% e Visa e
Mastercard a 2,5%, mais IVA. Para um ISP cabo-verdiano devia ser a via online principal, à frente
do Stripe (ADR 0016).

O pagamento web do Vinti4 ([documentação SISP](https://www.vinti4.cv/documentation.aspx?id=682))
funciona assim:

- o comerciante gera um formulário assinado (SHA-512 sobre o `posAutCode`);
- o browser do cliente submete-o a `mc.vinti4net.cv`;
- o resultado volta por POST ao `urlMerchantResponse` do comerciante.

O SISP não tem API de consulta de estado nem webhook. O ISPM corre num PC sem endereço público e
não usa relays na nuvem (ADR 0013, ADR 0016). Por isso, nem recebe a resposta nem pode perguntar
por ela.

O **EasyLink** ([documentação](https://www.vinti4.cv/documentation.aspx?id=1322)) é o serviço do
SISP para links de pagamento criados no Portal do Comerciante. Não pede desenvolvimento, não tem
custo de adesão nem mensalidade.

## Decisão

O Vinti4 entra como **EasyLink colado à mão**. O ISPM não fala com o SISP.

- **Ativação** na aba **Pagamento** das Configurações, que antes se chamava Stripe. O Vinti4 fica em
  cima, como via principal, e o Stripe em baixo, como secundária. Ligar o Vinti4 exige uma conta de
  tesouraria ativa: a conta onde o SISP deposita.
- **Na ficha da fatura** há uma opção "Vinti4 (EasyLink)" no método de pagamento. O operador cria o
  link no portal pelo saldo e cola-o. O URL guarda-se em `payments.vinti4_link_url` e o saldo desse
  momento em `vinti4_link_amount_cve` (migração 0094). Há um link por fatura; colar outro substitui o
  anterior.
- **Só aceita links do SISP.** O URL vai para os clientes, por isso só se aceita `https`, sem
  credenciais nem porta, e com host em `vinti4.cv`, `vinti4net.cv` ou `sisp.cv`.
- **Os avisos levam o link.** `openPaymentLinkSql` expande `{link}` para o EasyLink, mas só quando o
  Vinti4 está ligado, a fatura não está anulada e o valor do link ainda é o saldo. Na falta dele,
  usa o link Stripe aberto. Um link de valor antigo nunca se envia, como no ADR 0016.
- **O recibo é manual.** Quando o portal mostra o link como Pago, o operador regista o recibo na
  mesma ficha, pela porta de sempre (`payPayment`). O método é `outro`, porque o CHECK de
  `payment_method` está lançado desde a 0001. A conta vem pré-escolhida: é a do Vinti4.

## O que fica de fora

- **Confirmação automática.** Exige um endpoint público. O caminho, se um dia se aceitar um relay,
  é este:
  - o ISPM assina o formulário localmente e publica-o num worker mínimo;
  - o worker só serve o formulário e guarda a resposta;
  - o ISPM sonda o worker e valida o fingerprint de resposta localmente, de modo que o
    `posAutCode` nunca sai do PC.
  Fica por confirmar com o SISP quanto tempo vale o `timeStamp` assinado.
- **Comissão como despesa.** O ISPM não sabe se o cartão foi vinti4 ou internacional.
- **Criar o EasyLink por API.** O SISP não a expõe.

## Consequências

- Sem automação, um link pago e esquecido deixa a fatura em aberto até alguém registar o recibo.
- Um recibo parcial deixa o link desatualizado: a ficha avisa e o link deixa de seguir nos avisos
  até ser substituído.

# ADR 0017: Faturas manuais com serviço opcional

## Estado

Aceite e implementado localmente. A migração e os fluxos de emissão e pagamento
foram validados em testes e numa cópia da base instalada.

## Contexto

A geração mensal, a instalação e a venda de equipamento já emitem faturas.
Falta emitir uma fatura avulsa, com descrições e valores escritos pelo operador,
incluindo vendas a pessoas que ainda não têm serviço de Internet.

Recibos, crédito, documentos, avisos e relatórios identificam a dívida pelo
cliente. Tornar o cliente opcional exigiria alterar esses fluxos e perderia a
identidade e o histórico do destinatário.

## Decisão

- O destinatário é sempre um Cliente. O formulário escolhe um existente ou
  regista um novo, sem serviço, na mesma transação da emissão. A inserção usa
  `insertClient`, também utilizada pelo cadastro normal, incluindo a atribuição
  de um código disponível.
- O Serviço é opcional. Quando indicado, tem de pertencer ao destinatário e
  não pode estar cancelado. A dívida segue as regras de suspensão desse serviço.
  Sem serviço, a fatura não pode suspender qualquer acesso.
- A migração 0081 permite `payments.service_id` nulo e acrescenta `avulso` às
  linhas. A reconstrução mantém identidades, referências e índices existentes.
- Uma fatura manual tem entre uma e vinte linhas positivas. Cada valor é
  arredondado ao centavo e o total soma esses valores em centavos inteiros.
  Datas inexistentes, emissão futura e vencimento anterior à emissão são
  recusados.
- A referência é `AVULSA-<id>`. O número de fatura é atribuído na emissão,
  dentro da mesma transação, e o crédito do cliente é aplicado nesse momento.
  Depois de emitida, anula-se e emite-se outra; não se apaga nem se regenera
  como mensalidade.
- Documentos e listas usam junções opcionais ao Serviço. Os relatórios agrupam
  as referências manuais em Avulsas, mantendo dívida e recebido nos totais.
- Administradores e operadores podem emitir. A auditoria regista destinatário,
  número, valor e serviço associado. Técnicos não podem emitir.
- O link Stripe é opcional e é pedido depois da emissão local. Uma falha de
  Internet ou do Stripe deixa a fatura emitida; o link pode ser pedido na ficha.

## Consequências

Quem recebe uma fatura avulsa aparece em Clientes e pode ser escolhido numa
compra seguinte. O histórico, os recibos e o crédito permanecem associados a
essa pessoa, mesmo quando não contrata Internet.

A venda manual não retira equipamento do stock. A taxa e o regime de IVA são
os das Configurações, como nos restantes documentos. Editar documentos já
emitidos, IVA por linha e movimentos de stock ficam fora desta entrega.

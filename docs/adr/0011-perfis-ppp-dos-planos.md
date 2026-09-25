# ADR 0011: O ISPM cria os perfis PPP dos planos

- Estado: aceite (2026-09-25)
- Revê: ADR 0007 (superfície de escrita no router) e ADR 0008 (de onde sai a velocidade)

## Contexto

Contra o router real, o `rate-limit` num secret foi recusado: no RouterOS a velocidade é do perfil PPP
(PR #166). A primeira resposta foi o operador fazer o perfil de cada plano no Winbox e escrever o nome no
plano. O utilizador quer mais: ver os perfis do router dentro do ISPM e criar a partir dali o perfil de um
plano, sem abrir o Winbox.

## Decisões

- **Os perfis que já existem aparecem numa lista** no campo do plano (`GET /api/network/router/profiles`).
  O ISPM não cria planos a partir deles: preço e mensalidade são decisões comerciais, não do router.
- **O ISPM pode criar o perfil de um plano.** Copia do *perfil-base* (`routerosBaseProfile`, por omissão
  `default`) o que dá rede ao cliente: `local-address`, `remote-address`, `dns-server` e `only-one`. Junta
  o `rate-limit` tirado dos Mbps do plano (`<upload>M/<download>M`, rx/tx do lado do router). Cópia campo a
  campo, sem `copy-from`, que a REST não prova.
- **Posse pela marca.** O perfil criado leva `comment=ispm:plano:<id>`, a mesma âncora dos secrets. O ISPM
  só volta a mexer em perfis com a marca do próprio plano, e só no `rate-limit`. Um perfil feito no router
  e escolhido na lista nunca é alterado. O ISPM nunca apaga perfis.
- **Só em modo efetivo.** Em ensaio, "Criar/Atualizar no router" responde com o que faria e não escreve,
  coerente com "Ensaio (não altera nada no router)". É uma ação explícita de um administrador, com
  auditoria, e não corre na reconciliação periódica.

## Consequências

- A superfície de escrita no router passa a incluir `PUT`/`PATCH /ppp/profile`, limitada aos perfis
  marcados. O utilizador da API continua sem tocar em firewall, rotas, serviços ou utilizadores.
- Mudar os Mbps de um plano não altera o router sozinho: é preciso carregar em "Atualizar no router". A
  sessão viva de cada cliente só apanha o limite novo quando reconectar (ADR 0008).
- Um perfil-base errado dá perfis que não entregam endereço. A decisão fica visível nas Definições, com o
  texto a dizer de onde se copia.

# ADR 0014: O desvio feito no router fica retido

## Estado

Aceite. Implementados o motor (migração 0077) e a reconciliação (`lib/reconciliation.ts`, aba Reconciliação
do Router de gestão) e a mudança de plano em massa (migração 0078, `lib/plan-change.ts`, nos Serviços). Falta ver tudo a
correr contra o router real.

Revê o ADR 0007 ("uma divergência causada por alguém a mexer no Winbox é reportada, não sobreposta em
silêncio") e o ADR 0008 (aprovisionamento como divergência).

## Contexto

O ADR 0007 prometia reportar o que se muda no Winbox, mas a passagem só via *router ≠ ISPM* e aplicava a
diferença. Fora do ensaio, um perfil mudado à mão durava no máximo dois minutos, sem aviso. O operador
não tinha como mudar um cliente de plano no router sem o ISPM o desfazer, nem o ISPM como perguntar qual
dos dois lados estava certo.

Faltava ao motor uma memória: sem saber o que estava combinado, uma mudança de plano no ISPM e uma mexida
no Winbox são indistinguíveis.

## Decisões

- **Guarda-se o último acordo por serviço.** `service_network_state` ganha `confirmed_secret_id`,
  `confirmed_username`, `confirmed_profile` e `confirmed_enabled`: o que o ISPM pedia da última vez que o
  router o tinha — porque já o tinha, ou porque a passagem o escreveu com sucesso.

- **Intenção nova empurra-se; desvio do router retém-se.** Com router ≠ ISPM:
  - o ISPM pede algo diferente do acordo (ou nunca houve acordo) → é intenção nova, e aplica-se como
    sempre: aprovisionamento, corte por dívida, reposição, mudança de plano;
  - o ISPM pede o mesmo que o acordo → foi o router que mudou. Fica `profile_drift`, `state_drift` ou
    `secret_removed`, **sem ação nenhuma**, em todas as passagens até alguém decidir.

- **Um secret apagado no router não renasce sozinho.** Só conta como apagado se o serviço já teve secret
  com o mesmo utilizador PPPoE. Um serviço que nunca teve, ou cujo utilizador mudou no ISPM, continua a
  ser aprovisionado.

- **Uma ação falhada não é acordo.** O confirmado só avança quando o router tem o valor; uma escrita que
  falhou volta a ser tentada na passagem seguinte, em vez de ficar presa como desvio. O corte de segurança
  (perfil de suspensão indisponível) apaga o acordo do estado, pela mesma razão.

- **O ensaio não cria acordo.** Sem escrita não há prova de que o router tem o valor.

- **A decisão é do operador, serviço a serviço.** "Sincronizar" na ficha do serviço impõe o ISPM
  (`overrideDrift`). A passagem periódica e o "Reconciliar agora" nunca o fazem. A direção contrária —
  trazer o valor do router para o ISPM — é do ecrã de reconciliação.

- **Reconciliar é escolher a direção, linha a linha.** O ecrã mostra quatro tipos de diferença — plano,
  estado, só no ISPM, só no router — pelo *acesso* que cada lado dá: desativado e perfil de suspensão
  são o mesmo "sem serviço", e não aparecem como diferença entre si. *ISPM → router* esquece o acordo
  desse campo e corre uma passagem só desse serviço; *router → ISPM* escreve na base (o estado sempre por
  `changeServiceStatus`) e dá a nova intenção como acordada, para o que ainda diferir ficar retido em vez
  de ser empurrado. Um secret só do router nunca é apagado nem vira cliente: desativa-se, ou associa-se a
  um serviço que já exista. Em ensaio nada se escreve, em nenhum dos lados.

- **As decisões manuais esperam pela vez.** "Reconciliar agora", "Sincronizar" e as decisões da
  reconciliação entram na mesma fila (`runExclusive`) da passagem periódica e do lote, e leem o router só
  quando chega a vez delas. Fora da rede de gestão respondem logo que não podem, sem tentar.

- **Mudança de plano em massa: três tempos por serviço.** A base e o router não partilham transação. Por
  serviço: escreve-se o plano novo com o item `pending`, chama-se o router, e só então o item fica
  `applied` e o perfil novo passa a ser o acordo; se o router recusar, a base volta atrás e o item fica
  `failed` com o erro. Em série, com pausa entre chamadas, na mesma fila da passagem periódica
  (`runExclusive`) — nunca duas escritas ao mesmo tempo no router.
  - Um erro num serviço não pára os outros. O router deixar de responder pára o lote: o que faltava fica
    `not_processed`.
  - O plano de destino é validado contra os perfis do router antes da primeira escrita.
  - Repetir a operação não faz nada: quem já está no plano e no perfil fica `unchanged`, sem chamada.
  - Um suspenso muda de plano na base e fica no perfil de suspensão. Um serviço sem secret no router só
    muda na base, e isso fica escrito no item; a operação não cria secrets.
  - Não se derrubam sessões por omissão. "Agora" derruba só quem está ligado; "agendado" derruba, à hora,
    só as sessões abertas antes da mudança, e expira sem derrubar ninguém se passar mais de uma hora (o PC
    esteve desligado).
  - `plan_change_batches` e `plan_change_items` são o histórico: nomes copiados, sem chaves para serviços
    ou planos, para sobreviver a um serviço apagado. Cada item deixa também uma linha em `audit_logs`.
  - Um lote interrompido por o ISPM fechar é fechado no arranque; o serviço apanhado a meio tem o plano
    novo na base, e a passagem automática acerta o router por ser uma intenção nova.

## Consequências

- Na primeira passagem depois da migração não há acordo nenhum: o comportamento é o de antes, e o acordo
  nasce aí. Um desvio que já existisse nesse momento é sobreposto uma última vez.
- Um suspenso reposto à mão no Winbox fica com serviço até alguém decidir. É o preço de não haver
  exceções: aparece como divergência no painel e na ficha, não passa despercebido.
- `secret_id` continua a dizer só o que está no router; a memória de um secret apagado vive em
  `confirmed_secret_id`.

## Alternativas rejeitadas

- **Reter só o perfil e continuar a impor o estado.** Dois regimes para a mesma tabela, e o operador
  deixava de poder repor um cliente no router numa emergência sem o ISPM o cortar outra vez.
- **Nada automático.** Parava o corte por dívida e o aprovisionamento, que são mudanças do próprio ISPM.
- **Comparar com o perfil lido na passagem anterior** (`profile`, que já existia). Diz o que o router
  tinha, não o que estava combinado: depois de um desvio, a leitura seguinte já o dava como normal.

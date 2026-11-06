# ADR 0022: Política de uso justo (FUP) sobre o PPPoE que já existe

## Estado

Aceite (2026-11-06). Assenta nos ADR 0007 e 0008 (a base é a intenção, o router a realidade), no
ADR 0011 (perfis PPP dos planos) e no ADR 0015 (contador de consumo no router).

## Contexto

Cada plano passa a ter um consumo mensal de referência. O ISPM:

- avisa o cliente perto do limite;
- passado o limite, reduz a velocidade só nas horas de pico, até ao ciclo seguinte.

A contagem soma download e upload. Todos os limites são configuráveis e cada alteração fica num
histórico que não se apaga.

## Decisão

**Nada de stack nova nem de caminho novo para o router.** A FUP decide; quem escreve no MikroTik é a
reconciliação que já existe.

- **Consumo.** Vem do contador PPPoE do ADR 0015, sem tabela `consumo_mensal` nova:
  - por dia e serviço em `client_traffic_daily`;
  - última leitura em `client_usage_state`;
  - leitura abaixo da anterior conta como reinício de sessão (`counterDelta`).

  O consumo do ciclo é a soma dos dias do ciclo. O intervalo de leitura do ISPM segue
  `intervalo_recolha_minutos`. O agendamento do script no router fica como está: 5 min com disco,
  1 h sem disco, para não gastar a flash.
- **Cliente PPPoE.** O cliente PPPoE é o `services` (utilizador, plano, ativação). Não há tabela
  paralela; o ciclo começa em `services.fup_cycle_day` ou, se estiver vazio, no dia da ativação (até
  28).
- **Velocidades.** São as que o plano já tem (`download_mbps`/`upload_mbps`). Uma segunda coluna em
  kbps divergiria da primeira.
- **Estado.** Fica em `fup_events`, com chave única (serviço, período, tipo):
  - dentro de um ciclo o estado só sobe (normal → aviso → limitado);
  - o aviso nunca se repete;
  - `RESTAURADO` fecha o período limitado anterior.

  Subir o limiar a meio do ciclo levanta a limitação logo, sem apagar o evento.
- **Aplicação.** Enquanto o serviço estiver limitado no ciclo, a reconciliação mantém uma fila
  simples `ispm-fup-<serviço>` à frente da fila dinâmica da sessão, com `time` igual à janela e
  `max-limit` à percentagem de pico (plano > global > default). O RouterOS aplica a janela pelo
  seu relógio, mesmo com o ISPM fechado. Alterações da janela ou velocidade atualizam a fila;
  a reposição do ciclo ou a perda das condições de limitação remove-a. Sem sessão, a fila é
  criada na passagem seguinte depois de a sessão regressar.
  O fuso observado no router é comparado com o configurado e divergências são apresentadas ao
  operador. Não se convertem horas: o relógio do router deve ser acertado.
- **Router indisponível.** Não há fila de pendentes: o estado desejado recalcula-se em cada
  passagem, e a passagem seguinte aplica o que faltou sem reaplicar ordens velhas.
- **Configuração.**
  - Vive em `fup_settings`, com cache em memória invalidada a cada gravação.
  - A validação olha para o conjunto inteiro.
  - O histórico grava-se na mesma transação, e triggers impedem UPDATE e DELETE nele.
  - Só o administrador grava.
- **Aviso.**
  - Sai pelas filas de WhatsApp ou SMS que já existem.
  - `whatsapp_opt_out` vale para os dois canais, como no resto do ISPM.
  - E-mail fica recusado na validação, porque o ISPM não tem envio de e-mail.

## Consequências

- No CHR 7.24.2 foi medida a fila estática à frente da dinâmica e a passagem do tráfego para a
  dinâmica fora da janela, sem uma nova reconciliação do ISPM. O RouterOS devolve os horários e
  taxas normalizados (`18h-23h` e bit/s), que são comparados pelos seus valores efetivos.
- O método PROFILE foi removido: um perfil PPP não consegue aplicar um horário autonomamente.
- **Por ver no hEX S de produção:** o débito real limitado. A licença livre do CHR corta a 1 Mbit/s,
  por isso no laboratório mediu-se a ordem das filas e quem conta os bytes, não a velocidade.

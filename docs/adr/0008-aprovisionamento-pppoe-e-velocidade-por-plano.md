# ADR 0008: Aprovisionamento PPPoE, velocidade por plano e confiança no router

## Estado

Aceite e implementado. Estende o ADR 0007, que fixou a forma do controlo de acesso mas parou antes do
cliente RouterOS. O MikroTik chegou ao terreno; isto é o que se construiu à volta dele.

## Contexto

O ADR 0007 decidiu o essencial: a base de dados é a intenção, o router é a realidade, e a reconciliação é
um job — não uma chamada disparada de dentro de um formulário. Faltavam três decisões que só fazem sentido
com hardware à frente:

1. **Como é que um cliente novo passa a existir no router** sem alguém abrir o Winbox.
2. **De onde sai a velocidade** de cada cliente, quando `internet_plans.download_speed` é texto livre.
3. **Como se confia no certificado** de um router que, por natureza, tem um certificado próprio.

## Decisões

- **O aprovisionamento não é um caminho novo: é uma divergência.** Criar um serviço escreve apenas
  `pppoe_username`/`pppoe_password` na base de dados (migração 0039). Um serviço com utilizador e sem
  secret no router é `missing_secret`, e a passagem seguinte da reconciliação cria-o. Isto evita o que
  o ADR 0007 rejeitou noutro contexto: uma chamada de rede dentro de uma transação SQL, com o serviço
  gravado e o router por escrever — ou pior, o contrário.

- **Credenciais só com o router ligado.** Sem `routerosEnabled`, um serviço novo não recebe utilizador
  PPPoE: não se inventam credenciais que ninguém vai usar no parque TP-Link que ainda existe. Um serviço
  antigo ganha identidade quando alguém lhe escreve o utilizador no formulário — a migração para PPPoE
  faz-se ao ritmo do terreno, cliente a cliente, e a reconciliação ignora quem ainda não tem.

- **A âncora do mapeamento é o `comment` do secret**, `ispm:<serviceId>`, e não o nome. Um utilizador
  renomeado no Winbox continua a ser reconhecido; o nome é só o fallback.

- **Velocidade em colunas numéricas, não adivinhada do texto.** `download_mbps`/`upload_mbps` (migração
  0039) alimentam o `rate-limit`. A migração pré-preenche só o que é inequívoco ("10 Mbps"); o resto fica
  nulo, e nulo significa *não escrever velocidade nenhuma*. Um plano sem números deixa em paz o que estiver
  configurado à mão no router — o contrário seria estrangular um cliente que paga por causa de um parse.

- **A verificação de TLS nunca se desliga.** O certificado que o operador confirma passa a ser a própria
  âncora de confiança (`ca`), e a identidade é validada em `checkServerIdentity` — que o Node chama antes
  de escrever fosse o que for no socket, portanto as credenciais não saem se o certificado não for aquele.
  A leitura do certificado para o operador confirmar é um aperto de mão à parte, sem credenciais.
  `rejectUnauthorized: false` no caminho autenticado está fora de questão: entregaria a senha do router a
  quem estivesse no meio, antes de qualquer verificação nossa.

- **Trava de segurança no número de cortes.** Uma passagem que queira desativar mais do que
  `routerosMaxDisablesPerRun` (5 por omissão) não desativa nenhum e reporta. Um corte em massa é quase
  sempre um erro de dados ou de mapeamento; o custo de esperar por uma confirmação humana é uma hora, o
  custo de cortar meia cidade é a operação toda.

- **Repor antes de cortar.** Dentro de uma passagem, as ações aplicam-se por esta ordem: criar, repor,
  velocidade, cortar. Se a passagem falhar a meio, ninguém fica sem serviço à espera do tick seguinte.

- **Um corte deixa dois rastos.** `audit_logs` (com ator `sistema`) e um evento no histórico do cliente,
  `corte_rede`/`reposicao_rede` (migração 0040). A suspensão em 0038 regista a *intenção*; estes registam
  o *facto*. A distância entre os dois é exatamente o que se quer poder responder quando o cliente
  telefona a dizer que pagou e continua sem internet.

## Consequências

- Criar um serviço com o router ligado dá acesso à rede sem ninguém abrir o Winbox; a senha fica visível
  na ficha do serviço para o técnico a configurar no equipamento do cliente.
- Mudar um cliente de plano muda-lhe a velocidade na passagem seguinte, sem intervenção.
- O ensaio (dry-run) vem ligado e é o único modo utilizável até alguém o desligar de propósito. O relatório
  de divergências é o que se confere contra o parque real antes disso.
- O que estiver no router e não no ISPM é reportado como `orphan_secret` e **nunca apagado**.

## Alternativas rejeitadas

- **Criar o secret no momento da criação do serviço.** Junta uma chamada de rede a uma transação SQL e
  duplica o caminho de escrita que a reconciliação já tem.
- **Derivar a velocidade do texto livre do plano.** "10 Mbps", "10/2", "Ilimitado" e "até 10M" não são um
  formato; um erro de parse aqui é um cliente estrangulado sem ninguém perceber porquê.
- **Fixar apenas a impressão digital do certificado.** Obriga a aceitar a ligação primeiro e a verificar
  depois — e "depois" é tarde: as credenciais já saíram.
- **Filas (queues) a 0 em vez de desativar o secret.** Já rejeitado no ADR 0007 e continua rejeitado: um
  link que "funciona mas não presta" gera chamadas de apoio, não pagamentos.

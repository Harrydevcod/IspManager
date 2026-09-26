# Cofre de credenciais e campos protegidos

**Data:** 2026-09-24

**Estado:** Aprovado e implementado (2.6). A decisão final está no ADR 0012. Os cortes face a esta spec estão no plano `docs/superpowers/plans/2026-09-24-cofre-de-credenciais.md`: sem rotação da chave de recuperação, AAD por `tabela.coluna` e não por linha, e sem quiescência de operações no restauro.

**Âmbito:** autenticação, Configurações, serviços PPPoE, backend local, backups e restauro

## Objetivo

Impedir que passwords e outros segredos persistidos voltem a aparecer na interface ou nas respostas da API depois de guardados, e garantir que os segredos reversíveis ficam sempre encriptados em repouso.

O operador pode ver apenas o valor novo que está a digitar. Depois de guardar, o campo volta ao estado trancado e o valor deixa o estado do renderer. Uma edição posterior começa com um campo vazio: o valor anteriormente guardado nunca é recuperado para o browser.

O desenho preserva a continuidade operacional num restauro para outra máquina. Os secrets PPPoE já existentes no MikroTik continuam no router; a chave de recuperação permite que o novo ISPM recupere a capacidade de os gerir sem os substituir.

## Estado atual e problemas confirmados

- As passwords das contas ISPM usam `scrypt` com sal aleatório e não são devolvidas pela API. Este é o comportamento correto e será mantido.
- `routerosPassword`, `ultraMsgToken`, `smsCompanionPairingKey` e `auth_secret` passam hoje por `secrets.ts`, com formato `enc:v1:` quando o `safeStorage` do Electron está disponível.
- O backend de desenvolvimento corre como processo Node separado. Nesse processo o `safeStorage` não está disponível e a implementação atual degrada silenciosamente para texto simples.
- A instalação analisada tem segredos de infraestrutura selados, mas `auth_secret` em texto simples devido a esse fallback.
- `services.pppoe_password` está em texto simples. Existe atualmente uma credencial PPPoE configurada nessa condição.
- `GET /api/services` inclui `pppoePassword` em claro para administradores e operadores.
- Configurações devolve uma máscara reutilizável como sentinela. A máscara evita revelar o segredo, mas mantém o campo editável e mistura estado de apresentação com o contrato da API.
- O ADR 0009 excluiu expressamente passwords PPPoE da selagem por causa do risco de restauro. O requisito agora aprovado substitui essa decisão e exige uma solução de recuperação portátil.

## Decisões de segurança

### 1. Passwords de autenticação continuam irreversíveis

Passwords de utilizadores ISPM não serão encriptadas. Continuam armazenadas como hashes `scrypt` com sal aleatório, porque o backend só precisa de verificar a password e nunca precisa de recuperar o original.

Encriptar estas passwords seria uma regressão: criaria uma chave capaz de recuperar todas as passwords. Os fluxos de criação, alteração e reset recebem um novo valor, calculam o hash e descartam o texto original.

### 2. Segredos recuperáveis entram num cofre encriptado

Entram no cofre:

- password da API RouterOS;
- token UltraMsg;
- chave de pareamento SMS;
- passwords PPPoE dos serviços;
- futuros tokens, API keys ou passwords que o backend tenha de apresentar novamente a outro sistema.

O cofre usa uma chave de dados aleatória de 256 bits. Cada valor é cifrado individualmente com AES-256-GCM, nonce aleatório e dados autenticados que vinculam o ciphertext ao respetivo contexto, por exemplo:

- `setting:routerosPassword`;
- `setting:ultraMsgToken`;
- `service:<id>:pppoePassword`.

Vincular o ciphertext ao contexto impede que alguém troque dois valores cifrados dentro da base de dados e obtenha uma utilização válida noutro campo.

O formato persistido é versionado para permitir rotação e evolução futura. Nenhum formato desconhecido é tratado como texto simples.

### 3. Encriptação falha fechada

Uma escrita de segredo nunca pode cair para texto simples. Se o cofre não estiver disponível, a operação falha com erro explícito e não altera o valor anterior.

O arranque também não pode apagar ciphertext que não consiga abrir. A aplicação entra no estado `vault_locked`, preserva os dados e bloqueia as operações dependentes do cofre até haver recuperação.

Testes usam um fornecedor de chave explícito e isolado. Não existe bypass implícito baseado apenas em `NODE_ENV` que possa chegar a produção.

### 4. Proteção local e recuperação portátil

A chave de dados tem duas proteções independentes:

- **proteção local:** uma cópia embrulhada pelo `safeStorage` do Electron, ligada à conta do sistema operativo e usada para arranque automático na máquina atual;
- **proteção de recuperação:** outra cópia embrulhada por uma chave de recuperação de alta entropia, necessária para restaurar noutra máquina.

A chave de recuperação é apresentada uma única vez a um administrador, com confirmação explícita de que foi guardada. Enquanto estiver pendente de entrega, a sua cópia temporária fica também protegida pelo sistema operativo; nunca fica em claro na base de dados.

Depois da confirmação, só permanece o material criptográfico necessário para validar a chave e abrir a cópia de recuperação da chave de dados. A chave de recuperação pode ser rodada; ao rodar, a proteção anterior deixa de abrir o cofre.

O backup inclui o ciphertext dos segredos e a cópia de recuperação da chave de dados. Não inclui a chave de recuperação em claro.

### 5. A chave de sessão fica fora do cofre portátil

`auth_secret`, usado para assinar sessões, permanece protegido localmente pelo sistema operativo. Não precisa de sobreviver a uma mudança de máquina.

Num restauro, uma nova chave de sessão é gerada e todas as sessões anteriores são invalidadas. Os utilizadores continuam a poder autenticar-se porque os hashes `scrypt` estão no backup. Depois de entrar como administrador, é possível desbloquear o cofre com a chave de recuperação.

Isto evita um ciclo impossível em que o utilizador precisaria de desbloquear o cofre antes de conseguir iniciar sessão.

## Contratos da API

### Configurações

As respostas deixam de incluir máscaras em campos de segredo. Em vez de `routerosPassword: "••••••••"`, devolvem apenas metadados não sensíveis, por exemplo:

- `routerosPasswordConfigured: boolean`;
- `ultraMsgTokenConfigured: boolean`;
- `vaultStatus: "ready" | "recovery_pending" | "locked"`.

Atualizações distinguem ausência de alteração, substituição e remoção:

- propriedade ausente: manter o segredo existente;
- novo texto não vazio: substituir;
- ação explícita de remoção: apagar.

Uma máscara nunca é aceite como valor especial.

O teste RouterOS aceita uma password temporária apenas quando o campo está em edição. Quando está trancado, o renderer omite a password e o backend usa diretamente a que está guardada. A resposta de diagnóstico nunca contém a credencial.

### Serviços PPPoE

`GET /api/services` deixa de selecionar ou devolver `pppoe_password` para qualquer papel. Devolve apenas:

- `pppoeUsername`;
- `pppoePasswordConfigured`;
- `pppoePasswordPending`;
- estado observado do router.

A password é definida na criação do serviço ou na rota dedicada de alteração. A resposta confirma apenas se a operação alterou o estado; nunca ecoa o valor.

O motor de reconciliação é o único consumidor que decifra a password PPPoE, e apenas no instante de criar ou atualizar o secret no MikroTik. Planos, divergências, auditoria, erros e logs nunca incluem o valor.

### Autorização

- Configuração e recuperação do cofre: apenas administrador.
- Alteração de password PPPoE: administrador e operador, mantendo a política atual.
- Leitura de estado: conforme os papéis atuais, sempre sem o segredo.
- Recuperação e rotação deixam eventos de auditoria sem material sensível.

## Interface

### Componente de segredo protegido

Será criado um padrão reutilizável com três estados:

1. **Não configurado:** campo vazio e ação `Definir`.
2. **Trancado:** indicador `Configurado`, ícone de cadeado e ação `Editar`.
3. **Em edição:** input vazio, ação de cancelar e botão de olho para mostrar ou ocultar apenas o texto atualmente digitado.

Regras:

- o input nunca recebe o valor persistido;
- desbloquear não faz qualquer pedido de leitura do segredo;
- guardar com sucesso limpa o draft e volta a trancar;
- cancelar, fechar diálogo ou mudar de registo limpa o draft;
- erros mantêm o draft apenas enquanto o formulário continua aberto, para permitir correção;
- o olho nunca existe no estado trancado porque não há valor para revelar;
- autocomplete e spellcheck são configurados conforme o tipo de segredo;
- estados, ações e visibilidade têm nomes acessíveis e funcionamento por teclado.

### Autenticação e utilizadores

- Login, configuração inicial, criação de utilizador, reset e confirmação de password recebem botão de olho enquanto o utilizador digita.
- Editar um utilizador não carrega nem representa a password existente.
- A alteração de password usa a ação dedicada de reset/alteração; o formulário principal mostra apenas que a conta tem password configurada.
- Após sucesso ou cancelamento, o texto é removido do estado React.

### Configurações e PPPoE

- RouterOS e UltraMsg usam o componente trancado.
- O formulário normal de edição do serviço não recebe a password PPPoE existente.
- Num serviço existente, `Alterar password` abre o diálogo dedicado com input vazio e olho.
- Num serviço novo, a password pode ser introduzida e vista durante a digitação; depois de criar, desaparece da UI.
- Quando a password é gerada automaticamente, a UI não a passa a tratar como valor recuperável. Qualquer entrega inicial necessária ao cliente deve ser um fluxo explícito e auditado, não uma leitura posterior genérica.
- O pareamento SMS pode revelar a chave apenas dentro do QR/código durante o fluxo de pareamento. Depois de concluído, mostra apenas o estado de pareamento.

## Migração e arranque

Será adicionada uma migração versionada para os metadados do cofre. A conversão dos valores depende do fornecedor criptográfico e ocorre numa passagem transacional de arranque, antes do backup de arranque.

Ordem:

1. aplicar migrações SQL;
2. abrir ou inicializar o cofre;
3. converter valores legados `enc:v1:` usando o `safeStorage` da máquina atual;
4. cifrar valores PPPoE e outros valores legados em texto simples;
5. verificar que cada ciphertext novo abre e corresponde ao valor original;
6. confirmar a transação;
7. só então executar o backup de arranque e os jobs.

Se qualquer linha falhar, a transação é revertida. O valor legado permanece intacto, nenhum backup novo é anunciado como protegido e a aplicação mostra um erro administrativo. Nunca se limpa uma credencial por não ser decifrável.

O backend de desenvolvimento passa a receber um fornecedor criptográfico real ligado ao Electron. O comportamento de desenvolvimento não pode continuar diferente do comportamento empacotado no que diz respeito à proteção de segredos.

## Restauro noutra máquina

O MikroTik mantém todos os secrets PPPoE já configurados; mover o ISPM não os apaga e não interrompe as sessões ou autenticações dos clientes.

Fluxo do ISPM restaurado:

1. a proteção local da máquina antiga não abre;
2. o cofre entra em `locked`, sem apagar dados;
3. a aplicação cria uma nova chave de sessão local e permite autenticação com as contas restauradas;
4. um administrador introduz a chave de recuperação;
5. o backend abre a chave de dados, valida os ciphertexts e cria uma nova proteção local;
6. o cofre passa a `ready` e as integrações retomam.

Enquanto o cofre está bloqueado:

- não há reconciliação RouterOS;
- não há envio WhatsApp ou SMS que dependa das credenciais;
- não há aprovisionamento ou mudança de password PPPoE;
- nenhuma credencial é regenerada automaticamente;
- dados comerciais e autenticação continuam disponíveis;
- a UI explica a ação necessária ao administrador.

## Segurança operacional

- O DRY RUN RouterOS permanece ligado durante este trabalho.
- A suspensão automática LIVE permanece desligada.
- Migração, recuperação e edição de segredos não alteram esses dois valores.
- Testes de regressão comprovam que guardar uma credencial não muda `routerosDryRun` nem `autoSuspensionEnabled`.
- Nenhum arranque, restauro ou erro de chave pode disparar escrita no router.
- Os logs podem conter nomes de campos e identificadores, nunca valores, hashes de valores, ciphertexts completos ou chaves.

## Estratégia de testes

### Criptografia

- round-trip AES-256-GCM;
- nonce diferente produz ciphertext diferente para o mesmo valor;
- AAD incorreto, tag alterada ou ciphertext truncado falham fechados;
- formato desconhecido é rejeitado;
- escrita sem cofre disponível não persiste texto simples;
- rotação da chave de recuperação invalida a anterior;
- buffers de chave temporários são limpos quando tecnicamente possível.

### Persistência e migração

- segredos novos nunca aparecem em claro no SQLite;
- PPPoE legado em claro é convertido antes do backup;
- `enc:v1:` legado é convertido sem perda;
- falha numa linha reverte a passagem inteira;
- segunda passagem é idempotente;
- restauro noutra máquina preserva ciphertext e entra em `locked`;
- recuperação reembrulha a chave local sem recifrar todas as credenciais.

### API

- nenhum papel recebe password PPPoE;
- Configurações devolve apenas flags;
- propriedades ausentes mantêm segredos;
- substituição e remoção são explícitas;
- respostas, auditoria e erros não ecoam valores;
- autorização de configuração, recuperação e PPPoE é aplicada.

### Interface

- segredo configurado começa trancado e sem valor no DOM;
- editar abre input vazio;
- olho alterna apenas o draft;
- guardar e cancelar limpam o draft;
- editar utilizador não oferece a password antiga;
- diálogos de autenticação e alteração têm controlo de visibilidade acessível;
- o estado `vault_locked` impede ações dependentes do cofre e orienta recuperação.

### Rede e segurança

- reconciliação decifra apenas no ponto de aplicação;
- dry-run não escreve nem limpa flags pendentes;
- cofre bloqueado não contacta o router com credenciais vazias;
- recuperar o cofre não executa reconciliação automaticamente;
- DRY RUN e suspensão automática permanecem nos valores anteriores.

## Alternativas consideradas

### Apenas mascarar e trancar a UI

Rejeitada. A API continuaria a transportar passwords PPPoE e a base de dados continuaria em claro. Uma máscara visual não é uma fronteira de segurança.

### Usar somente `safeStorage` por campo

Rejeitada como solução final. Protege bem a máquina atual, mas torna centenas de passwords PPPoE irrecuperáveis num restauro e o backend Node de desenvolvimento atual não tem acesso ao mecanismo.

### Guardar a chave de cifra junto da base de dados

Rejeitada. Quem copiar o backup copia a chave e os ciphertexts, anulando a proteção.

### Cifrar a base inteira com uma chave local

Rejeitada para este requisito. Mantém o problema de distribuição e recuperação da chave, aumenta o custo operacional e não substitui contratos de API que não devolvam segredos. O cofre por campo protege precisamente os dados que precisam de reversibilidade e permite evolução versionada.

## Impacto nos ADRs

Este desenho mantém os princípios de proteção local do ADR 0009, mas substitui duas decisões:

- deixa de ser permitido o fallback para texto simples;
- `services.pppoe_password` passa a ser protegido pelo cofre.

Um novo ADR deve registar o cofre com recuperação portátil e marcar essas partes do ADR 0009 como substituídas. O ADR 0008 também deve deixar de afirmar que a password PPPoE fica visível na ficha do serviço.

## Critérios de aceitação

- Nenhuma password persistida aparece novamente na UI ou numa resposta da API.
- Todos os inputs de password permitem mostrar apenas o valor novo durante a digitação.
- Campos persistidos ficam trancados e exigem uma ação explícita para editar.
- Passwords de utilizadores permanecem hashes `scrypt`.
- Segredos reversíveis e PPPoE nunca são persistidos em texto simples.
- A aplicação não tem fallback de produção ou desenvolvimento para texto simples.
- Um backup restaurado noutra máquina pode recuperar o cofre com a chave de recuperação.
- Sem recuperação, os secrets permanecem preservados e o router não é alterado.
- Os PPPoE já existentes continuam no MikroTik durante mudança ou restauro da máquina.
- DRY RUN não é desligado e a suspensão automática LIVE não é ativada.

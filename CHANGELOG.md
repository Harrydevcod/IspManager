# Changelog

Todas as versões notáveis do ISPM. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/). Cada versão tem uma [Release no GitHub](https://github.com/Harrydevcod/IspManager/releases) com o instalador correspondente.

## [1.6.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.6.0) — 2026-07-21

### Novidades

- **Taxa de instalação automática.** Define um preço de instalação em Configurações › Faturação e ele passa a ser faturado uma única vez, no momento em que crias cada serviço. Um plano pode ter o seu próprio preço de instalação, que tem precedência sobre o valor global.
- **Gráfico do dashboard clicável.** Clicar num mês do gráfico de receita abre diretamente os Pagamentos desse mês.
- **Tabela de Pagamentos mais limpa.** Mais espaço para a descrição e ações alinhadas à borda do cartão.

## [1.5.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.5.0) — 2026-07-14

### Alterações
- feat(sms): relatório mensal de entregas de SMS

## [1.4.9](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.9) — 2026-07-06

### Financeiro — Pagamentos com ações num só menu

As ações de cada cobrança deixam de ser uma fila de até **11 ícones** lado a lado e passam a viver num **único menu `⋯`** por linha, encostado à direita. Mais limpo, mais rápido, e sem o risco de clicar por engano numa ação destrutiva.

Ao abrir o menu, as ações aparecem **agrupadas** e só as válidas para o estado da cobrança:

- **Ação** — Registar pagamento + Lembrete WhatsApp (pendente/atraso), ou Recibo PDF (pago)
- **Documentos** — Fatura PDF
- **Comunicação** — Enviar por WhatsApp · Enviar por SMS · Recibo por WhatsApp
- **Gestão** — Marcar atraso · Anular · Reverter geração · Regenerar mensalidade

Detalhes que fazem a diferença:

- O menu **abre para cima** quando a linha está no fundo da lista, e ganha scroll interno se ficar apertado — nunca ficas sem ver uma ação.
- As ações de **Anular** e **Reverter** continuam a passar pelos diálogos de confirmação de sempre — nada destrutivo fica a um clique.
- Uma cobrança **anulada** não mostra menu; clicar na linha continua a abrir a pré-visualização.

Sem alterações fiscais nem de base de dados — é uma melhoria de interface do dia-a-dia em Financeiro → Pagamentos.

## [1.4.8](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.8) — 2026-07-06

### Financeiro — Pagamentos passa a ser a primeira aba

O módulo **Pagamentos** deixa de ser uma entrada isolada na sidebar e passa a viver **dentro do Financeiro** como a **primeira** sub-aba (aba de aterragem). Uma só área financeira coerente:

**Pagamentos · Lucro · Investimentos · Despesas**

- Abrir **Financeiro** aterra diretamente em Pagamentos — o ecrã do dia-a-dia à frente.
- Os atalhos do Dashboard (pagamentos em atraso / pendentes) continuam a funcionar, agora a abrir Financeiro na aba Pagamentos com o filtro correto.
- O aviso de atraso passa a aparecer na entrada **Financeiro** da sidebar.

Atualização automática a partir de versões anteriores (Windows e Linux).

## [1.4.7](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.7) — 2026-07-05

### Financeiro — auditoria de regras de negócio + associação multi-cliente

**Associação exata de investimento a vários clientes**
- Uma antena de transmissão pode agora ligar-se a um conjunto exato de clientes (ex.: Starlink que serve toda a rede).
- Botão **"Todos os ativos"** associa todos os clientes ativos de uma vez; **"Limpar (N)"** remove todos. Chips individuais para adicionar/remover cliente a cliente.
- Motor de atribuição em waterfall: a receita de cada cliente vai aos investimentos que o reclamam (dividida quando partilhado), senão à zona, senão ao pool — cada escudo contado uma única vez.

**Correções da auditoria (laranja + amarelo)**
- Médias de OPEX passam a usar meses com dados (não o span do calendário).
- Rateio usa denominador de serviços reais; ROI anual honesto (lucro×12/capital); média de ROI ponderada por capital.
- Timeline distribui OPEX pelo mês real e aplica quota global aos não-ligados.
- Datalists de zonas, aviso de CAPEX na categoria errada, defaults e sincronização estado↔recuperação.

**Design**
- Diálogo "Novo investimento / editar" redesenhado: grid de 12 colunas, campos alinhados, larguras e cores corrigidas.

Atualização automática a partir de versões anteriores.

## [1.4.6](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.6) — 2026-07-04

### ISPM 1.4.6

- **Novidades desta versão dentro da aplicação**: o menu Sobre mostra as notas de cada versão num diálogo com o visual da app — secções, destaques e modo escuro — em vez da janela cinzenta do sistema.
- **Notas das versões privadas**: removido o link que abria a página pública no browser; as novidades agora vivem só dentro da aplicação.
- **Versão correta em desenvolvimento**: o menu mostrava a versão do Electron em vez da versão do ISPM quando corrido em modo dev.

## [1.4.5](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.5) — 2026-07-04

### ISPM 1.4.5

- **Pendente do mês — legenda coerente**: o tile passa a contar as cobranças que **vencem no mês corrente** ("N cobranças vencem este mês"), o mesmo critério do valor somado, em vez da contagem global de pendentes.

## [1.4.4](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.4) — 2026-07-04

### ISPM 1.4.4

- **Pendente do mês corrigido**: o tile passa a somar o que **vence** este mês por receber (base de vencimento). Com faturação pós-paga a competência do mês corrente só é gerada ao dia 30, pelo que o tile mostrava 0 o mês inteiro — mesma classe de bug da Receita do mês (v1.4.1).

## [1.4.3](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.3) — 2026-07-04

### ISPM 1.4.3

- **Diálogo de atualização profissional**: mensagem específica com versão instalada vs nova, ícone da app, botões "Reiniciar e instalar agora" / "Instalar ao fechar a aplicação".
- **Menu da aplicação em pt-PT** (Ficheiro, Editar, Ver, Janela, Sobre) com a **versão sempre visível** no menu Sobre, diálogo "Sobre o ISPM" e link para as notas das versões.
- **Dashboard responsivo**: tiles do comando operacional e indicadores adaptam-se ao tamanho da janela — valores como 141.500$00 encaixam em qualquer ecrã (colunas auto-fit + fontes em unidades de container).

## [1.4.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.2) — 2026-07-03

### ISPM 1.4.2

### Melhorias
- **Marca**: o ícone da app substitui a letra "I" na sidebar e no ecrã de autenticação.

## [1.4.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.1) — 2026-07-03

### ISPM 1.4.1

### Correções
- **Dashboard — Receita do mês**: o tile passa a regime de caixa (soma o que foi recebido no mês pela data de pagamento). Com a faturação pós-paga, a soma por competência mostrava 0$00 durante o mês inteiro mesmo com pagamentos recebidos. A tendência "% vs mês anterior" também compara agora caixa-com-caixa; o gráfico de receita mantém a visão por competência.

## [1.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.0) — 2026-07-03

### ISPM 1.4.0

### Tema
- Dark mode renovado: grafite mais claro tintado ao azul Windows, com efeito acrílico nativo do Windows 11 (tema claro permanece opaco)
- Novo modo "Acompanhar o Windows": a app segue o tema do sistema em tempo real; onboarding de primeiro arranque sugere a escolha

### Backups (Configurações)
- Painel redesenhado: estado do último backup, automático e retenção; histórico com badges e tempo relativo
- Seletor nativo de pasta de destino e atalho para abrir a pasta no Explorer
- Intervalo do backup automático com presets (Diário, Semanal, …)
- Correção: backups importados agora aparecem na lista e seguem a retenção

### Clientes e formulários
- Campo Ilha passa a lista fechada das 9 ilhas de Cabo Verde, com São Vicente pré-selecionada
- Relatórios → Incompletos arrumado: linhas alinhadas, badges de lacunas âmbar e filtros com estado visível
- Campos numéricos compactos (SMS, backups)

## [1.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.3.0) — 2026-07-02

### Novidades
- **Primeiro arranque numa máquina nova:** o ecrã de configuração passa a oferecer duas vias — criar a conta de administrador **ou importar um backup da base de dados** (diálogo nativo; valida, restaura com cópia de segurança e relança a app; entra-se com as credenciais do backup).

### Robustez
- Restauros de backup serializados (mutex): dois restauros em simultâneo já não podem corromper a base de dados.
- Nomes de ficheiros importados com precisão de milissegundos (sem colisões/sobrescritas).
- Restauro de primeiro arranque registado no log do processo.

## [1.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.1) — 2026-07-02

### Correções
- Dashboard: tiles do rail (Receita acumulada, Pendente acumulado, Atraso crítico) mostram o valor por extenso com três zeros de milhares — **131.000$00** em vez de `131k$`.

## [1.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.0) — 2026-07-02

### Documentos PDF (faturas/recibos)
- Descarregar volta a funcionar na app instalada (deixou de abrir no visualizador embutido).
- Guardar via diálogo nativo "Guardar como", com o nome correto do documento (ex.: `Fatura - Cliente - FT-2026-00001.pdf`).
- Novo botão **Imprimir** nas pré-visualizações (fluxo autenticado, sem expor token).
- Toolbar do visualizador de PDF escondida; ações passam pelos botões da app.
- Mês de referência no PDF por extenso (ex.: "Junho/2026").

### Faturação pós-paga
- Faturação manual assume por defeito o **mês fechado** (mesma regra da auto-faturação, dia 30).
- Catch-up de fim de mês recupera meses em falta sem gaps.

### Validação de datas
- Registar pagamento com data anterior à emissão da fatura é bloqueado com mensagem clara.
- Novo validador de coerência cronológica (referência ≤ emissão ≤ vencimento/pagamento).

### Localização pt-PT
- Datas em **dd-mm-aaaa** em toda a app, incluindo PDFs.
- Estados de pagamento em português (Pendente / Pago / Em atraso / Anulado).

### Manutenção
- Script one-off `scripts/fix-postpaid-reference-shift.cjs` para corrigir competências históricas desviadas +1 mês (dry-run por defeito, backup automático, guarda anti-rerun).

## [1.1.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.1.0) — 2026-06-30

### Novidades
- **Comando operacional** do Dashboard redesenhado: banner empilhado com chips de sinais (Atraso, Ordens) e tiles **Receita acumulada** e **Pendente acumulado** lado a lado, entre Receita e Vencimentos.
- Novos indicadores de cobrança: **Pendente do mês** (card) e **Pendente acumulado** (meses anteriores); **Receita acumulada** total no comando operacional.
- Removido o card "Planos ativos"; o gráfico de receita passa a ocupar a largura toda.

### Correções
- Stock baixo deixou de aparecer **duplicado** no Dashboard.
- Texto de estado vazio em **Financeiro/Lucro** encurtado.
- **Pagamentos**: colunas sempre alinhadas e agrupadas junto ao Cliente.

## [1.0.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.0.0) — 2026-06-29

ISPM 1.0.0

Release estavel do ISPM para operacao desktop.

Inclui:
- Versao da aplicacao atualizada para 1.0.0.
- Build Windows NSIS gerada com electron-builder.
- Ajuste final de layout na lista de pagamentos para preservar alinhamento das colunas e area de acoes.

Validacao:
- npm.cmd run lint
- npm.cmd run typecheck
- npx.cmd tsc -p tsconfig.main.json
- npm.cmd test -- --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=1
- npm.cmd run build

## [0.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.4.0) — 2026-06-28

_Sem notas._

## [0.3.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.1) — 2026-06-27

Release v0.3.1 — ativa o auto-update.

### O que muda
- **Auto-update via GitHub Releases** (electron-updater): a app passa a verificar atualizações no arranque, descarrega em silêncio e pergunta se reinicia para instalar.
- Esta é a **primeira release auto-updatável** — instalações a partir da v0.3.1 recebem futuras versões automaticamente. (A v0.3.0 não contém o updater e não se auto-atualiza.)

### ⚠️ Aviso de segurança
Os builds **não estão assinados** (sem certificado de code-signing). O Windows SmartScreen vai avisar na instalação (Mais informações → Executar mesmo assim). O canal de auto-update valida o SHA512 do binário sobre HTTPS, mas sem assinatura não há verificação do publisher — proteger a conta GitHub (2FA) é essencial.

### Instalação
Descarregar **`ISPM Setup 0.3.1.exe`** e executar.

## [0.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.0) — 2026-06-27

Release v0.3.0 — integra 9 melhorias estruturais e funcionais.

### Destaques
- **Numeração sequencial** real por série/ano dos documentos fiscais (sem gaps).
- **Dinheiro em centavos** internamente + formatação cifrão (`1.500$00`).
- **Segurança no login** — rate-limiting e lockout exponencial.
- **Schema Drizzle completo** + guarda de drift contra as migrations.
- **Renderer modular** — módulos monolíticos quebrados em sub-componentes.
- **Regra de negócio em libs de domínio** (handlers HTTP finos).
- **Observabilidade dos jobs** in-process (tabela `job_runs` + painel Automatismos).
- **Backups agendados** + pasta de destino configurável (Drive/Dropbox/OneDrive).
- **Funil de cobrança** configurável (lembrete → vencido → aviso → suspensão) com timeline no cliente.

### Instalação
Descarregar **`ISPM Setup 0.3.0.exe`** e executar. O build não está assinado — o Windows SmartScreen poderá avisar (Mais informações → Executar mesmo assim).

### Notas técnicas
- 363 testes verdes · typecheck backend + renderer limpos.
- `latest.yml` + `.blockmap` incluídos para futuro auto-update (electron-updater).

## [0.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.1) — 2026-06-25

### 🔧 Hotfix crítico

A **v0.2.0 instalava mas não abria**. O instalador empacotava o `better-sqlite3` na ABI do Node em vez da do Electron, pelo que o backend falhava no arranque e a janela nunca era criada.

Esta versão corrige o build (`electron-rebuild` forçado para a ABI do Electron + `npmRebuild: false`) e está verificada a abrir corretamente.

**⚠️ Não usar a v0.2.0 — substituída por esta.**

Inclui também as funcionalidades da v0.2.0:
- Apagar serviço mal criado (bloqueio fiscal se já houver faturas + reposição de stock)
- Mensalidade mostra total NET + TVM numa linha

## [0.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.0) — 2026-06-24

### ⚠️ Esta versão está OBSOLETA

O instalador da v0.2.0 **não abria** (módulo nativo empacotado na ABI errada). Os ficheiros foram removidos.

👉 **Usar a [v0.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.1)**, que corrige o problema e mantém todas as funcionalidades.

## [0.1.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.1.1) — 2026-06-18

### Correções

### Segurança
- Token de autenticação deixa de viajar nas URLs. Downloads e pré-visualização de PDF (fatura/recibo) passam a usar `authFetch` + `blob:` — o token vai no header `Authorization`, nunca na query string (que vazava para histórico e logs).
- `bearerToken()` endurecido: aceita apenas o header `Authorization`, rejeita `?token=`.

### Correção de download
- Nome do ficheiro restaurado para o formato completo `Recibo - <Cliente> - RC-2026-00077.pdf` (CORS passa a expor `Content-Disposition`).

---

# Changelog

Todas as versões notáveis do ISPM. O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/). Cada versão tem uma [Release no GitHub](https://github.com/Harrydevcod/IspManager/releases) com o instalador correspondente.

## [1.7.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.7.0) — 2026-07-28

### Adicionado

- **serviços:** IP fixo dos equipamentos visível na lista, no detalhe e na pesquisa — escrever um IP no filtro encontra o cliente daquela antena
- **serviços:** Editar a identificação de um equipamento instalado (IP, MAC, serial, tag) sem consumir stock
- **serviços:** Ecrã "Atribuir IPs" para preencher todos os equipamentos de uma vez, com busca e filtro por preencher
- **serviços:** Prefixo de IP sugerido a partir da rede já instalada
- **serviços:** Uma antena pode servir vários clientes (prédio com switch, antena com várias saídas de rede), sem duplicar stock e com o custo dividido pelos serviços servidos

### Alterado

- **clientes/serviços/pagamentos:** As listas abrem filtradas pelos estados ativos
- **serviços:** IP fixo só se aplica a antenas e pontos de acesso; routers de cliente usam IP dinâmico
- **serviços:** IPs são validados como IPv4 e recusados quando já pertencem a outro equipamento ativo

### Corrigido

- **serviços:** Campo de IP transbordava para fora do cartão no ecrã de atribuição

## [1.6.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.6.0) — 2026-07-21

### Adicionado

- **financeiro:** Taxa de instalação faturada ao criar serviço
- **dashboard:** Clique num mês do gráfico abre Pagamentos desse mês (#79)

### Alterado

- **financeiro:** Coluna Ações encostada à borda sem hack de margem

## [1.5.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.5.0) — 2026-07-14

### Adicionado

- **sms:** Relatório mensal de entregas de SMS (#78)

## [1.4.9](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.9) — 2026-07-06

### Adicionado

- **financeiro:** Ações de Pagamentos colapsadas num menu ⋯ por linha

## [1.4.8](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.8) — 2026-07-06

### Adicionado

- **financeiro:** Pagamentos passa a primeira aba do módulo Financeiro (#77)

## [1.4.7](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.7) — 2026-07-05

### Adicionado

- **financeiro:** Auditoria leva 2 — laranja (médias/rateio/ROI/timeline) + amarelos (zonas/CAPEX/defaults/sync) (#76)
- **build:** App multiplataforma — Linux AppImage no pipeline de builds (#74)
- **build:** Build macOS via GitHub Actions (DMG arm64 + Intel) (#72)

### Corrigido

- **financeiro:** Motor de atribuição sem dupla contagem + recuperação real + catch-up de despesas (#75)
- **ci:** Dispatch do build mac compila main + tag via env (injection) (#73)

## [1.4.6](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.6) — 2026-07-04

### Adicionado

- **app:** Novidades desta versão no design system + versão correta em dev (#71)
- **app:** Notas das versões privadas — link removido + Novidades in-app (#70)

## [1.4.5](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.5) — 2026-07-04

### Adicionado

- **dashboard:** Contagem do Pendente do mês por vencimento (#69)

## [1.4.4](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.4) — 2026-07-04

### Corrigido

- **dashboard:** Pendente do mês em base de vencimento (#68)

## [1.4.3](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.3) — 2026-07-04

### Adicionado

- **app:** Diálogo de atualização profissional + menu Sobre com versão visível (#67)

## [1.4.2](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.2) — 2026-07-03

### Adicionado

- **ui:** Ícone da app no lugar da letra I (sidebar + auth) (#66)

## [1.4.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.1) — 2026-07-03

### Corrigido

- **dashboard:** Receita do mês em regime de caixa (#65)

## [1.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.4.0) — 2026-07-03

### Adicionado

- **theme:** Dark mais claro + acrílico Win11 (#63)
- **ui:** Redesign backups, tema Windows-aware e ilhas fechadas (#62)

### Corrigido

- **reports:** Arruma e estiliza a secção Incompletos (#64)

## [1.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.3.0) — 2026-07-02

### Adicionado

- **setup:** Primeiro arranque permite restaurar backup em vez de criar admin (#61)

## [1.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.1) — 2026-07-02

### Corrigido

- **dashboard:** Tiles do rail com valor por extenso (131.000$00, não 131k$) (#60)

## [1.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.2.0) — 2026-07-02

### Corrigido

- **payments:** Downloads/impressão de PDF, faturação de mês fechado e validação de datas (#59)

## [1.1.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.1.0) — 2026-06-30

### Adicionado

- **ui:** Tile do rail mostra receita acumulada total (#57)
- **ui:** Pendente acumulado como tile do comando operacional (#56)
- **ui:** Pendente acumulado movido para comando operacional (#54)
- **ui:** Card "Pendente acumulado" no dashboard (meses anteriores) (#53)
- **ui:** Dashboard com Receita pendente e brief operacional com sinais (#48)

### Corrigido

- **ui:** Remove card "Planos ativos" do dashboard (#52)
- **ui:** Remove duplicação do alerta de stock baixo no dashboard (#51)
- **ui:** Brief operacional empilha banner em cima e tiles em baixo (#50)
- **ui:** Encurta texto de estado vazio em Financeiro/Lucro (#49)

## [1.0.0](https://github.com/Harrydevcod/IspManager/releases/tag/v1.0.0) — 2026-06-29

### Adicionado

- **ui:** Polish #8 — estados de carregamento nos módulos restantes (#39)
- **ui:** Skeleton de carregamento nos módulos de lista (+ nota #9) (#38)
- **ui:** Cheat-sheet de atalhos de teclado (tecla ?) (#37)
- **ui:** Ações em massa nos clientes (notificar / mudar estado) (#36)
- **ui:** Ações em massa nos pagamentos (seleção múltipla) (#35)
- **ui:** Tabelas com ordenação, header sticky e paginação (#34)
- **dashboard:** KPIs e alertas viram atalhos navegáveis (#33)
- **ui:** Autofocus no 1º campo ao abrir diálogos
- **ui:** Rollout do ErrorRetry a todos os módulos de dados
- **ui:** Skeletons de loading + erro com retry; consolida escala de espaçamento
- **ui:** Escala de espaçamento --space-* e normalização
- **ui:** Reverifica a saúde da API a cada 15s

### Corrigido

- **ui:** Colunas dos Pagamentos sempre alinhadas (ações largura fixa) (#47)
- **ui:** Não repetir "Fatura"/"Recibo" quando o número já traz FT/RC (#44)
- **security:** Endurece o save path do download contra path traversal (#43)
- **download:** Documentos guardam com nome informativo, não UUID aleatório (#42)
- **ui:** Número de fatura/recibo aparecia com prefixo duplicado (#41)
- **ui:** Célula de identidade na tabela voltava a colar código/nome/meta (#40)

## [0.4.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.4.0) — 2026-06-28

### Adicionado

- **stock:** Backbone por quantidade em vez de flag booleana
- **stock:** Distingue equipamento de backbone do de cliente

## [0.3.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.1) — 2026-06-27

### Adicionado

- **updater:** Auto-update via GitHub Releases + build.publish

## [0.3.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.3.0) — 2026-06-27

### Adicionado

- **db:** Cobre tabelas 0020/0022/0023 no schema Drizzle
- **db:** Schema Drizzle completo + guarda de drift contra as migrations
- **dunning:** Funil de cobrança configurável com timeline no cliente
- **backup:** Observabilidade do backup agendado via runJob
- **backup:** Configuração de backups no ecrã (pasta + agendamento)
- **backup:** Backups agendados + pasta de destino configurável
- **jobs:** Painel de saúde dos automatismos nas Configurações
- **jobs:** Regista execuções dos jobs in-process (tabela job_runs)
- **auth:** Rate-limiting e lockout exponencial no login
- **money:** Modulo partilhado de dinheiro + formatacao cifrao (1.500$00)
- **faturacao:** Numeracao sequencial real por serie/ano dos documentos

### Alterado

- **renderer:** Extrai abas de configuracoes em componentes
- **renderer:** Extrai ServiceItemDraftsBuilder de servicos
- **renderer:** Extrai ServiceDetailDialog de servicos
- **renderer:** Extrai PaymentsList de pagamentos
- **renderer:** Extrai PaymentDetailDialog de pagamentos
- **renderer:** Extrai dialogs de pagamentos
- **renderer:** Extrai componentes de pagamentos
- **documents:** Move geração de PDF para lib/documents
- **finance:** Extrai regra de serviços para lib/services
- **finance:** Extrai regra do ciclo de pagamentos para lib/payments

## [0.2.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.1) — 2026-06-25

### Corrigido

- **build:** Empacota better-sqlite3 na ABI do Electron (app não abria)

## [0.2.0](https://github.com/Harrydevcod/IspManager/releases/tag/v0.2.0) — 2026-06-24

### Adicionado

- **servicos:** Mensalidade mostra total NET + TVM numa linha
- **servicos:** Apagar serviço mal criado (bloqueio fiscal + reposição de stock)
- **servicos:** Serviço de Distribuição de Conteúdos Audiovisuais (add-on + standalone)

### Corrigido

- **faturacao:** Regenerar mensalidade preserva o valor audiovisual no total
- **build:** Compila deps nativas do fonte e fixa Electron 41.7.0

## [0.1.1](https://github.com/Harrydevcod/IspManager/releases/tag/v0.1.1) — 2026-06-18

- **Versão inicial** do ISPM.

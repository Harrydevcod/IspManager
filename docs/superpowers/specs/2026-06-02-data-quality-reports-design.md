# Qualidade de dados (em Relatórios) — Design

**Data:** 2026-06-02
**Estado:** Aprovado
**Módulo:** Relatórios (`ReportsModule`) + backend `reports`

## Objetivo

Dar ao operador uma vista de diagnóstico da saúde dos dados de clientes, dentro
do módulo Relatórios existente: clientes com dados incompletos e possíveis
duplicados, com ação direta para corrigir no sítio certo (abrir o cliente) e
para dispensar falsos positivos de duplicados.

Enquadra o PLAN #4 (Qualidade de dados). Iteração 1, determinística e testável —
sem thresholds fuzzy a afinar.

## Arquitetura

Duas novas views no `ReportsModule` (`Incompletos`, `Duplicados`), alimentadas
por um endpoint dedicado, separado do `/api/reports/summary` por ter shape
próprio e para não inchar cada pedido de relatório:

- `GET /api/reports/data-quality` — `requireRole(['admin','operator'])`.
- `POST /api/reports/data-quality/dismiss` — `requireRole(['admin','operator'])`.

O módulo mantém o padrão atual: tabs por view, metric-grid de contagens, tabela
paginada, `EmptyState`, export CSV.

## 1. Incompletos

Classificação por flags, por cliente:

- `noPhone` — `phone` nulo/vazio. Bloqueia cobrança e lembrete WhatsApp.
- `noActiveService` — cliente `active` sem nenhum `service` com `status='active'`.
- `noAddress` — sem `address` **ou** sem `island`/`zone`.
- `noNif` — `nif` nulo/vazio.

Resposta:

- `incompleteCounts: { noPhone, noActiveService, noAddress, noNif, total }`
  (`total` = clientes com pelo menos uma flag). Alimenta o metric-grid.
- `incompleteClients: Array<{ id, clientCode, fullName, status, phone, flags: string[] }>`
  paginado.

Query param `issue?: 'noPhone'|'noActiveService'|'noAddress'|'noNif'` filtra a
lista por categoria; sem `issue`, lista todos os clientes com ≥1 flag.

`noActiveService` aplica-se a clientes não cancelados (um cancelado sem serviço
ativo é estado normal, não um defeito de dados).

## 2. Duplicados

Deteção determinística, O(n) por hashing — robusto para a escala de um ISP
(centenas a milhares de clientes):

- **Por telefone normalizado:** só dígitos, remove prefixo de país `238`.
  Agrupa; grupos com ≥2 clientes são candidatos. (Nota: `phone` é `UNIQUE`
  no schema, portanto isto apanha variações de formatação que escaparam ao
  constraint — ex. com/sem espaços, com/sem `+238`.)
- **Por chave de nome normalizada:** minúsculas, acentos removidos, espaços
  colapsados, tokens ordenados alfabeticamente. Apanha "João Silva" /
  "joao  silva" / "Silva, João".

Um grupo é "possível duplicado" se tem ≥2 clientes e o par não foi dispensado.
A resposta entrega grupos:

- `duplicateGroups: Array<{ key, reason: 'phone'|'name', clients: Array<{ id, clientCode, fullName, phone }> }>`

Levenshtein / near-match fica explicitamente fora desta iteração.

## 3. Resolver duplicados (dispensa)

Nova tabela:

```sql
CREATE TABLE IF NOT EXISTS client_duplicate_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id_low INTEGER NOT NULL REFERENCES clients(id),
  client_id_high INTEGER NOT NULL REFERENCES clients(id),
  dismissed_by INTEGER REFERENCES users(id),
  dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_id_low, client_id_high)
);
```

`POST /api/reports/data-quality/dismiss { clientIdA, clientIdB }`:

- Normaliza o par para `(low, high)` com `low < high`.
- `INSERT OR IGNORE` (idempotente).
- Escreve audit log (`entityType:'client'`, `action:'dismiss_duplicate'`).
- A deteção de duplicados exclui qualquer grupo cujo par esteja dispensado.
  Para grupos de >2 clientes, um par dispensado remove só esse par; o grupo
  permanece se ainda houver outro par não-dispensado.

## 4. Abrir cliente (navegação)

Segue o padrão já usado por `Dashboard` (`onOpenClients`):

- `ReportsModule` ganha prop `onOpenClient(clientId: number)`.
- `App.tsx` mantém `focusClientId` em estado; o callback faz
  `setFocusClientId(id); setSection('clients')`.
- `ClientsModule` ganha prop opcional `focusClientId?: number` + efeito que,
  ao mudar, carrega o cliente (ou seleciona da lista já carregada) e abre o
  painel de detalhe. Limpa o foco após consumir para não re-disparar.

## UI

- Duas tabs novas em `ReportsModule`: `Incompletos`, `Duplicados`.
- **Incompletos:** metric-grid com as 4 contagens (clicável para filtrar por
  `issue`); tabela com código, nome, badges das lacunas; linha clicável →
  `onOpenClient`. `EmptyState` quando não há incompletos.
- **Duplicados:** lista de grupos; cada grupo mostra os clientes lado a lado,
  a razão (telefone/nome), botão "Abrir" por cliente e "Marcar não-duplicado"
  por par/grupo. `EmptyState` quando não há duplicados.
- Export CSV para ambas as views, seguindo `exportCsv` atual.
- As views de qualidade de dados não usam os filtros de data (como `stock`).

## Migração

`0013_client_duplicate_dismissals` — segue o padrão `CREATE TABLE IF NOT EXISTS`
das migrações existentes.

## Testes (Vitest)

Backend `data-quality`:

- cada flag de incompleto (noPhone, noActiveService, noAddress, noNif) isolada;
- `noActiveService` ignora clientes cancelados;
- agrupamento por telefone normalizado (variações de formatação);
- agrupamento por nome normalizado (acentos, espaços, ordem de tokens);
- exclusão de pares dispensados da deteção;
- idempotência da dispensa (`INSERT OR IGNORE`);
- 403 sem role admin/operator.

Cleanup de testes respeita ordem child-first por causa das FKs (ver
`ispm-fk-and-test-flakiness`).

## Validação

- `npm.cmd run typecheck`
- `npm.cmd test`
- `npx.cmd tsc -p tsconfig.main.json`

## Fora de escopo

- Merge automático de clientes duplicados.
- Importação assistida (PLAN #4 separado; `ClientsModule` já tem `showImport`).
- Near-match por distância de edição (Levenshtein).

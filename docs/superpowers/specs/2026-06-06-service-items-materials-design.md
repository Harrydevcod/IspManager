# Vários equipamentos + materiais por serviço — Design

> Estado: aprovado (brainstorming). Próximo passo: plano de implementação.
> Data: 2026-06-06 · Branch: `feat/service-items-materials`

## Contexto

O PR #9 (mergeado) introduziu a instalação de **um** equipamento ao criar um serviço,
com abate de stock e impacto na rentabilidade do cliente. Uma instalação real, porém,
envolve **vários equipamentos** (router + ONT + AP…) e **materiais consumíveis**
(cabo por metro, conectores, fichas, suportes…) que se medem em quantidade, não em série.

Schema atual relevante:
- `equipment_catalog` — `type CHECK(type IN ('cpe','router','antena','switch','outro'))`, **sem** unidade de medida; `stock_total INTEGER`. Sem conceito de "material".
- `service_device_assignments` — **1 linha = 1 equipamento** (serial/asset/IP/MAC, `end_date`, unicidade de serial ativo). Já suporta vários equipamentos; só o formulário de criação enviava um.
- `stock_movements` — já tem `quantity` (INTEGER) e `type IN ('entrada','saida','devolucao','ajuste')`.
- `lib/deviceInstall.ts` — motor partilhado de instalação (preflight + install dentro de transação), usado por `finance.ts` (criar com equipamento) e `technical.ts` (atribuir/trocar).

## Objetivos

Capturar, por serviço, todos os equipamentos e materiais de uma instalação, alimentando:
1. **Custo/rentabilidade** por cliente (custo real da instalação).
2. **Stock/inventário** exato (abate de tudo o que sai do armazém).
3. **Folha de materiais (BOM)** documentada por serviço.

**Fora de âmbito nesta iteração** (modelo não o impede, construção futura): faturar materiais
ao cliente (linhas faturáveis, preço de venda, integração com pagamentos/fatura).

## Decisões fechadas

| Decisão | Escolha | Razão |
|--------|---------|-------|
| Catálogo | **Unificado** (estende `equipment_catalog`) | Um só sítio para stock, custos, preços; uma só UI |
| Modelo de linhas | **Abordagem A — duas tabelas** | Cada tabela fiel ao seu ciclo de vida; zero churn na lógica de troca |
| Quantidades | **Inteiras** (metros inteiros, unidades) | Suficiente para ISP CV; mantém `stock_total`/`quantity` INTEGER |
| Faturação | **Desenhada, não construída** | YAGNI; adicionar colunas depois é migração barata, não rebuild |

## Arquitetura

### 1. Catálogo unificado — migration `0018` (rebuild)

Pela regra do CHECK gotcha (nunca alterar CHECK de migração shippada → **rebuild** da tabela:
criar nova com novo CHECK, copiar dados preservando `id`, dropar antiga, renomear, recriar
índices), a `0018` reconstrói `equipment_catalog` adicionando:

- `category TEXT NOT NULL DEFAULT 'equipamento' CHECK(category IN ('equipamento','material'))`
- `unit_of_measure TEXT NOT NULL DEFAULT 'un'` — `un`, `metro`, `caixa`, `par`, …
- `is_serialized INTEGER NOT NULL DEFAULT 1` — equipamento=1, material=0
- `type` CHECK alargado para incluir `'cabo','conector','ficha','suporte'` além dos atuais
  (`'cpe','router','antena','switch','outro'`); `'outro'` mantém-se como catch-all.

Linhas existentes preservadas: `category='equipamento'`, `unit_of_measure='un'`, `is_serialized=1`.
O **nome** `equipment_catalog` mantém-se (passa a ser "catálogo de itens de stock") para evitar
churn em todo o código — trade-off consciente.

**Segurança da migração:** o rebuild corre com `PRAGMA foreign_keys` desligado (FKs de
`service_device_assignments` e `stock_movements` referenciam `equipment_catalog(id)`); os `id`
são preservados na cópia; índices recriados (`idx_eq_catalog_type` + novos para `category`).

### 2. Linhas de instalação/consumo

- `service_device_assignments` — **inalterada** (equipamento serializado, ciclo de vida completo).
- **Nova** `service_material_lines` (migration `0018`):
  ```
  id INTEGER PK
  service_id INTEGER NOT NULL REFERENCES services(id)
  catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id)
  quantity INTEGER NOT NULL CHECK(quantity > 0)
  unit_cost_cve REAL NOT NULL DEFAULT 0        -- custo landed no momento do consumo
  notes TEXT
  created_by INTEGER REFERENCES users(id)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ```
  Sem `end_date` (material é consumido, não devolvido). Índices em `service_id` e `catalog_id`.
  Reversão de material (futuro): apagar/anular a linha + movimento `devolucao` compensatório — fora de âmbito.

### 3. Motor de instalação partilhado — `lib/deviceInstall.ts` → `lib/serviceInstall.ts`

Renomear o ficheiro (criado há 1 dia, churn baixo) para refletir o âmbito alargado. Funções:

- `installDeviceWithinTx(db, { serviceId, clientName, device, userId })` — serializado, qty 1. **Mantém-se.**
- `consumeMaterialWithinTx(db, { serviceId, clientName, catalogId, quantity, unitCost, notes, userId })`
  — insere `service_material_lines`; insere `stock_movements` `'saida'` (qty N, `unit_cost_cve` = custo landed);
  abate `stock_total` em N. Re-valida stock dentro da transação (segurança de corrida) → lança `stock_insufficient:<n>`.
- `preflightItems(db, items)` — valida cada item antes da transação e devolve resultado discriminado:
  - catálogo existe;
  - serializado → `stock_total ≥ 1` e serial/asset não duplicados num ativo;
  - material → `stock_total ≥ quantity`;
  - técnico (se indicado) existe.
- `mapInstallError(error)` — mantém-se (mapeia `stock_insufficient:<n>` → 400).

**Eventos:** um único `service_event` `'instalacao'` por lote, com resumo dos itens (em vez de um
evento por equipamento). Menos ruído no histórico técnico.

### 4. Endpoints

- `POST /api/services` — `device` (singular) → **`items?: Item[]`**. `Item = { catalogId, quantity?,
  serialNumber?, assetTag?, ipAddress?, macAddress?, technicianId?, notes? }`. O backend ramifica por
  `is_serialized` do catálogo: serializado → device assignment (qty forçada a 1); material → material line
  com `quantity`. **Tudo numa transação** (rollback se qualquer linha falhar; `preflightItems` valida tudo
  antes de abrir a transação para nunca deixar serviço órfão). Resposta inclui ids criados.
- **Novo** `POST /api/services/:id/items` — instalação em lote (equipamentos + materiais) para um serviço
  existente; usado pelo diálogo "Adicionar" pós-criação. Mesma validação/motor. **Substitui** o endpoint
  single `POST /api/services/:id/device-assignments` (folded no batch; testes atualizados em conformidade).
- `POST /api/services/:id/device-replacement` (troca) — **mantém-se** para swaps de equipamento.

**Itens serializados vs materiais:** numa linha serializada, `quantity` é sempre 1 (cada linha = uma
unidade com o seu serial/MAC/IP). Para instalar 3 routers adicionam-se 3 linhas. O campo `quantity`
aplica-se apenas a materiais.
- `GET /api/services/:id/technical-history` — passa a devolver `{ serviceId, assignments, materials, events }`.

### 5. Rentabilidade — `routes/clients.ts`

À query `installedEquipmentUsed` (já soma device assignments) junta-se `installedMaterialsUsed`
(soma `service_material_lines × custo` por cliente, agrupado por item). Fundem-se em `equipmentUsed`
(mantém o nome no contrato da API; passa a representar todos os itens). `installationCostCve` += custo
dos materiais. BOM visível na rentabilidade e no histórico técnico.

### 6. Frontend

- **StockModule** — formulário do catálogo ganha `categoria` (equipamento/material), `unidade` e
  `serializado`, permitindo criar itens como "Cabo UTP" (metro) ou "Conector RJ45" (un).
- **Builder de itens** — a secção de equipamento do formulário de criação **e** o diálogo "Adicionar"
  pós-criação passam a ser um construtor multi-linha: "Adicionar item" → escolhe item do catálogo;
  se serializado → campos serial/MAC/IP/asset (qty 1); se material → campo quantidade. Lista de linhas
  com remover; submete `items[]`.
- **Detalhe do serviço (ServicesModule)** — histórico técnico com dois grupos: **Equipamentos**
  (assignments) e **Materiais** (linhas com qty + custo).
- **Rentabilidade do cliente (ClientsModule)** — a lista `equipmentUsed` já renderiza; passa a incluir
  materiais (com qty/unidade).

### 7. Testes

- Migração `0018`: rebuild preserva linhas e ids; colunas novas com defaults corretos.
- Catálogo aceita item `category='material'`, `unit_of_measure='metro'`, `is_serialized=0`.
- Instalação em lote (2 equipamentos + 1 material) abate stock correto (equip. −1 cada; material −N) e
  cria as linhas certas + um evento `'instalacao'`.
- `preflightItems` rejeita material com stock insuficiente → 400 com rollback total (sem serviço, sem linhas, sem movimentos).
- Rentabilidade inclui custo dos materiais e lista o material no `equipmentUsed`.
- `technical-history` devolve `materials`.
- Os 234 testes atuais mantêm-se verdes (ajustar os que assumiam `device` singular / um evento por equipamento).

## Notas de migração de contrato

- Frontend e testes que enviavam `device` (singular) no `POST /api/services` migram para `items: [ ... ]`.
- `technical-history` ganha o campo `materials` (aditivo).
- O endpoint single `POST /api/services/:id/device-assignments` é substituído pelo batch
  `POST /api/services/:id/items`; os testes que o exercem migram para o novo contrato.

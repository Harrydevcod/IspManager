# Distinção backbone vs cliente no equipamento

> Marca equipamento de transmissão (backbone) no catálogo e torna o seu capital
> visível em separado na rentabilidade, sem o confundir com equipamento instalado
> por cliente.

**Data:** 2026-06-28
**Estado:** Implementado — ver nota de revisão no fim.

---

## Problema

As duas antenas TP-Link CPE710 são infraestrutura de backbone — antenas de
transmissão de sinal, não equipamento instalado em casa de cliente. Hoje o
sistema não as distingue:

- **Catálogo/Stock** (`equipment_catalog`): só tem `category`
  (equipamento/material) e `type` (cpe/antena/…). Não há forma de marcar uma
  entrada como infraestrutura de transmissão. Uma CPE710 de backbone é
  indistinguível de uma CPE de cliente.
- **Rentabilidade** (`investments` totals): o valor de stock comprado é somado
  num único número (`stockAcquiredCve` → `totalInvestedCve`). O capital de
  backbone fica mentalmente atribuído por cliente, quando é infraestrutura
  partilhada.

## Objetivo

Uma marca única — `is_backbone` no catálogo — que serve as duas camadas:
inventário (badge + filtro) e rentabilidade (valor de backbone separado).

## Não-objetivos

- Não se resolve a dupla-contagem potencial entre a tabela `investments` (CAPEX
  manual) e o stock do catálogo. Já existe hoje; fica como teto conhecido.
- Backbone **não** altera rateio de OPEX, ROI por cliente, nem qualquer cálculo
  de rentabilidade por investimento. É apenas capital visível em separado.
- Não há criação automática de registo na tabela `investments` quando se marca
  um item como backbone (decisão do utilizador: só visibilidade pelo stock).

---

## Design

### Dados — migration `0025`

```sql
ALTER TABLE equipment_catalog ADD COLUMN is_backbone INTEGER NOT NULL DEFAULT 0;
```

`ADD COLUMN` não exige rebuild da tabela (não toca em CHECK existente). Default
`0` → todo o catálogo atual fica como "cliente", comportamento inalterado.

Atualizar `schema.ts` (Drizzle) com a coluna `isBackbone` e garantir que o teste
de drift Drizzle↔migrations continua verde.

### Backend

**`stock.ts`** — `catalogSchema`:
- Aceitar `isBackbone: z.coerce.boolean().default(false)` no POST/PUT.
- Persistir em `is_backbone` (0/1).
- Devolver `isBackbone` (boolean) nas queries de catálogo.

**`investments.ts`** — query de "stock comprado":

A query atual soma todo o stock do catálogo + saídas:

```
stockAcquiredCve =
    SUM(stock_total * landed_cost) sobre equipment_catalog
  + SUM(quantity * unit_cost_cve) sobre stock_movements WHERE type='saida'
```

Passa a calcular, em paralelo, a fatia backbone:

```
backboneStockCve =
    SUM(stock_total * landed_cost) sobre equipment_catalog WHERE is_backbone=1
  + SUM(sm.quantity * sm.unit_cost_cve) sobre stock_movements sm
      JOIN equipment_catalog ec ON ec.id = sm.catalog_id
      WHERE sm.type='saida' AND ec.is_backbone=1
```

onde `landed_cost = purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve`.

- `totalInvestedCve` **inalterado** (backbone é um subconjunto do stock já contado;
  não soma nem subtrai).
- Expor `backboneStockCve` em `totals`.

> Nota: confirmar na implementação que `stock_movements` tem `catalog_id` para o
> JOIN das saídas. Se não tiver, a fatia backbone das saídas é omitida e
> `backboneStockCve` cobre apenas o stock em mãos — documentar como limitação.

### Frontend

**`StockModule.tsx`**
- `StockFormState`: campo `isBackbone: '1' | '0'` (default `'0'`).
- Toggle "Backbone (transmissão)" no formulário do catálogo.
- `<Badge tone="info">Backbone</Badge>` na linha da lista quando `isBackbone`.
- Opção de filtro para mostrar só backbone (reutilizar o padrão de filtro
  existente; pode ser um valor extra no filtro ou um filtro próprio).

**`ProfitModule.tsx`**
- Novo `MetricCard` "Backbone / transmissão" com `formatCve(totals.backboneStockCve)`,
  junto ao "Total investido". `tone="info"`, `trend="infraestrutura de sinal"`.

**`types.ts`**
- `StockCatalogRow`: `isBackbone: boolean`.
- `InvestmentList['totals']`: `backboneStockCve: number`.
- `EMPTY_INVESTMENT_LIST` em `ProfitModule.tsx`: incluir `backboneStockCve: 0`.

### Teste

Estender o teste de investimentos (`investments.test.ts`): criar um item de
catálogo com `is_backbone=1` e stock conhecido + um item de cliente. Assertar:

- `totals.backboneStockCve` == valor landed esperado do item backbone.
- `totals.totalInvestedCve` continua a contar ambos (inalterado pela flag).

---

## Ficheiros tocados

| Ficheiro | Mudança |
|----------|---------|
| `src/backend/db/migrations/0025_*.ts` | nova coluna `is_backbone` |
| `src/backend/db/schema.ts` | `isBackbone` no catálogo + drift |
| `src/backend/routes/stock.ts` | aceitar/devolver `isBackbone` |
| `src/backend/routes/investments.ts` | `backboneStockCve` em totals |
| `src/backend/routes/investments.test.ts` | asserção backbone |
| `src/renderer/types.ts` | `isBackbone` + `backboneStockCve` |
| `src/renderer/modules/StockModule.tsx` | toggle + badge + filtro |
| `src/renderer/modules/ProfitModule.tsx` | MetricCard backbone |

---

## Nota de revisão (2026-06-28, após smoke)

O smoke com dados reais mostrou um furo: o **mesmo modelo** pode ter unidades no
backbone **e** em clientes (ex.: TL-S5-5KM — 2 backbone, 6 instaladas). Uma flag
booleana por entrada de catálogo é tudo-ou-nada e marcaria as 8 como backbone.

**Correção (migration 0026 + PR seguinte):** a flag `is_backbone` é substituída
por uma **quantidade** `backbone_qty INTEGER` (quantas unidades do modelo são
backbone). As instaladas em clientes continuam rastreadas pelos assignments.

- `backboneStockCve = Σ(backbone_qty × custo landed)` — só visibilidade, não
  altera `totalInvestedCve`.
- UI: o toggle "Uso" passa a um campo numérico **"Unidades backbone"**; o badge
  mostra **"Backbone ×N"**; o filtro fica Com/Sem backbone.
- 0025 mantém-se imutável (já aplicada); 0026 adiciona `backbone_qty`, migra
  `is_backbone=1 → backbone_qty=stock_total`, e faz DROP da coluna booleana.

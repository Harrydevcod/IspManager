# Redesign: Rentabilidade & Capital Investido

**Data:** 2026-06-06
**Estado:** Design aprovado (a aguardar revisão do spec)
**Âmbito:** Backend (cálculo de rentabilidade por cliente + total investido da empresa) e Frontend (Clientes, Investimentos).

---

## 1. Problema

O cálculo de "total investido" e de rentabilidade tem falhas conceptuais e assimetrias:

1. **Equipamento devolvido continua a contar.** O custo de equipamento por cliente
   soma *todas* as `service_device_assignments`, sem filtrar `end_date`. Equipamento
   removido/substituído (que volta ao stock pela feature de remover/substituir) pesa
   como "investido" para sempre.

2. **CAPEX partilhado mal atribuído.** Um `investments` de zona/infra serve vários
   clientes mas, se tiver `client_id`, carrega 100% num só; se não tiver, não entra em
   cliente nenhum. O **OPEX de zona já é rateado** pelos clientes ativos — os dois lados
   tratam zona de forma diferente.

3. **Mistura recuperável com afundado.** Equipamento (recuperável, volta ao stock) é
   somado junto com materiais/mão de obra (afundados) numa só métrica, distorcendo
   "meses até recuperar" e "%".

4. **Métricas pouco claras.** O rótulo "Custo de instalação" inclui CAPEX amplo.

5. **Total investido geral não inclui stock adquirido.** No módulo Investimentos,
   `Total investido = Σ investimentos + Σ despesas`. Não inclui o capital gasto a
   **comprar inventário** (stock), e mistura OPEX (despesas) com investimento.

6. **Duplicação de fórmula.** A rentabilidade está calculada em dois sítios
   (`routes/clients.ts` e `lib/profitability-export.ts`), que podem divergir.

### Achados da investigação aos dados reais

Só existe uma BD com dados (`%APPDATA%/ISPManager/isp-manager.db`, dev, Maio 2026):

- **Sem tabela `investments`** → não há dados de investimentos; o dedup
  investimento↔stock não é mensurável empiricamente (ninguém usou a feature ainda).
- **`stock_movements.unit_cost_cve = 0` em todos os movimentos** → medir stock
  adquirido por `Σ entradas (qty × unit_cost do movimento)` daria 0. O custo fiável
  vive no **catálogo** (`purchase_price + shipping + customs + other` = *landed cost*).
- **`equipment_catalog` com stock total negativo (−8) e valor landed −68.000** →
  problema de integridade de stock à parte (fora de âmbito).

---

## 2. Decisões (acordadas)

| # | Decisão |
|---|---------|
| Modelo de lucro | **Recuperação de caixa.** Equipamento instalado conta como dinheiro a recuperar *enquanto está no cliente*; ao devolver, sai. |
| Rateio CAPEX | **Espelha o OPEX.** Cliente→100%; zona→÷ clientes ativos na zona; sem cliente/zona→pool ÷ clientes instalados ativos. Só status `ativo`/`em_execucao`/`recuperado`. |
| Separação | **Capital recuperável** (equipamento ativo + CAPEX rateado) vs **custos afundados** (materiais + mão de obra). |
| Stock adquirido | **`Σ (entrada.quantidade × landed cost do catálogo)`** — usa o custo fiável do catálogo, não o `unit_cost` do movimento. Captura de entradas passa a ser custeada pelo landed. |
| OPEX no total | **Separado.** "Total investido" = CAPEX infra + stock adquirido. OPEX mostrado à parte como custo operacional. |
| Dedup | Sem dados para investigar → **convenção:** stock = fonte de hardware/material; investimentos = infra não-inventável (torres, fibra, postes, obra, mão de obra). Sem sobreposição. Aviso futuro pode sinalizar item_types de hardware lançados como investimento. |
| Estrutura | **Fonte única** `computeClientProfitability()` partilhada por endpoint e export; `loadCompanyCapexContext()` em paralelo ao `opex.ts`. |

---

## 3. Design — Rentabilidade por cliente (cash-recovery)

```
Capital recuperável = equipamento instalado ATIVO (end_date IS NULL, landed cost)
                    + CAPEX rateado
Custos afundados    = materiais consumidos + mão de obra
─────────────────────────────────────────────
Investimento total  = capital recuperável + custos afundados
Lucro acumulado     = receita paga − investimento total − OPEX acumulado
Lucro mensal        = receita média mensal − OPEX mensal efetivo
Meses até recuperar = investimento total / lucro mensal     (se lucro mensal > 0)
Rentabilidade %     = lucro acumulado / investimento total × 100
```

### 3.1 Capital recuperável

- **Equipamento instalado ativo:** soma do landed cost
  (`purchase_price + shipping + customs + other`) das `service_device_assignments`
  do cliente **com `end_date IS NULL`**. (Hoje soma todas — passa a filtrar ativas.)
- **CAPEX rateado** (ver 3.3).

### 3.2 Custos afundados

- **Materiais consumidos:** `Σ service_material_lines.quantity × unit_cost_cve` do cliente.
- **Mão de obra:** `Σ service_install_costs.amount_cve` do cliente.
- Não recuperáveis: permanecem no investimento total mesmo após devolução de equipamento.

### 3.3 CAPEX rateado (espelha OPEX)

Novo `loadCompanyCapexContext()` em `lib/capital.ts`, análogo a `loadCompanyOpexContext()`,
mas com **totais** (não mensais), e considerando apenas investimentos de status ativo
(`ACTIVE_INVESTMENT_STATUSES`):

- `directByClient[clientId]` = `Σ total_cost_cve` de investimentos com `client_id` definido.
- `directByZone[zone]`       = `Σ total_cost_cve` de investimentos com `zone` (sem cliente).
- pool não-alocado           = `Σ total_cost_cve` de investimentos sem cliente nem zona.
- `capexPerClient`           = `pool ÷ totalInstalledActive` (mesma base que o pool OPEX).

No `computeClientProfitability`, a parcela CAPEX do cliente é:

```
capexZoneShare   = directByZone[zona] ÷ (clientes ativos na zona)
capexAllocated   = directByClient[clienteId] + capexZoneShare + capexPerClient
```

(Espelha exatamente como `clients.ts` já calcula `directZonePerClientCve` e
`imputedMonthlyOpexCve` para o OPEX.)

### 3.4 Equipamentos usados (display)

Lista `equipmentUsed` mantém-se, mas o **custo de equipamento instalado reflete só
atribuições ativas** (`end_date IS NULL`). `quantityUsed` = ativas, `quantity` = total
histórico (contexto). Itens de investimento só aparecem para investimentos `client_id`
diretos (zona/pool são parcelas rateadas, sem detalhe por cliente).

---

## 4. Design — Total investido geral (empresa)

No módulo Investimentos (`routes/investments.ts` GET + `InvestmentsModule`):

```
Total investido = CAPEX infra-investimentos + Stock adquirido
OPEX acumulado  = Σ despesas            (mostrado À PARTE, não somado ao total)
```

- **CAPEX infra-investimentos:** `Σ investments.total_cost_cve` (status ativo).
- **Stock adquirido** (`loadAcquiredStockValue()` em `lib/capital.ts`):

  ```sql
  SELECT COALESCE(SUM(sm.quantity *
           (ec.purchase_price_cve + ec.shipping_cost_cve
            + ec.customs_duty_cve + ec.other_costs_cve)), 0)
  FROM stock_movements sm
  JOIN equipment_catalog ec ON ec.id = sm.catalog_id
  WHERE sm.type = 'entrada'
  ```

### 4.1 Endurecer a captura de entradas

Para o stock adquirido ser fiável daqui para a frente, toda **entrada** de stock passa a
gravar `unit_cost_cve` = landed cost do catálogo no momento (em `routes/stock.ts` e onde
quer que se criem movimentos `entrada`). O cálculo do total usa o landed do catálogo via
JOIN (independente do `unit_cost` gravado), por isso é robusto a dados antigos a zero.

---

## 5. Estrutura de código

### Novos ficheiros
- **`src/backend/lib/capital.ts`**
  - `loadCompanyCapexContext(): CompanyCapexContext` — rateio CAPEX (totais).
  - `loadAcquiredStockValue(): number` — stock adquirido (entradas × landed).
- **`src/backend/lib/profitability.ts`**
  - `computeClientProfitability(clientId): ClientProfitability` — **fonte única**,
    usada pelo endpoint e pelo export. Move a lógica que hoje está inline em `clients.ts`.

### Modificados
- `src/backend/routes/clients.ts` — endpoint passa a delegar em `computeClientProfitability`.
- `src/backend/routes/investments.ts` — `totalInvestedCve` = CAPEX + stock adquirido;
  OPEX exposto separadamente (`totalOpexCve`).
- `src/backend/lib/profitability-export.ts` — usa `computeClientProfitability` (fim da
  duplicação) e reflete os novos campos.
- `src/backend/routes/stock.ts` (+ `lib/serviceInstall.ts` se aplicável) — custear entradas.
- `src/renderer/modules/ClientsModule.tsx` — grelha de Rentabilidade nova (ver 6).
- `src/renderer/modules/InvestmentsModule.tsx` — "Total investido" novo + OPEX à parte.
- `src/renderer/types.ts` — novos campos de `ClientProfitability` e dos totais.

---

## 6. UI

### Clientes — secção Rentabilidade
Substitui o único "Custo de instalação" por:

- **Investimento total** (destaque) — com sub-linha "recuperável + afundado".
- **Capital recuperável** — equipamento instalado ativo + CAPEX rateado.
- **Custos afundados** — materiais + mão de obra.
- Mantém: Faturamento total, Receita paga, Receita pendente, Lucro acumulado,
  Lucro mensal, Meses até recuperar, Rentabilidade %, Equipamentos usados.
- Badge Recuperado / Em retorno / Em prejuízo — sem alteração.

### Investimentos — cabeçalho
- **Total investido** = CAPEX + stock adquirido (com sub-linha a discriminar as duas
  parcelas).
- **OPEX acumulado** — card separado (já não dentro do total investido).
- Restantes KPIs (lucro mensal, ROI, lucro acumulado) mantêm-se.

---

## 7. Testes

- **`lib/capital.test.ts`** (novo): rateio CAPEX (cliente/zona/pool), stock adquirido
  (entradas × landed, robusto a `unit_cost=0`), só status ativos contam.
- **`lib/profitability.test.ts`** (novo): fórmula completa; equipamento devolvido
  (`end_date` não-nulo) sai do capital recuperável; separação recuperável/afundado.
- **`routes/clients.test.ts`**: ajustar para os novos campos; cenário devolver
  equipamento → investimento total desce, lucro sobe.
- **`routes/investments.test.ts`**: total investido = CAPEX + stock; OPEX separado.
- Limpeza child-first nos `beforeEach` (FK ON em runtime).

Verificação renderer: `npm.cmd run typecheck` + `npm.cmd run lint` + smoke manual
(sem harness de testes do renderer).

---

## 8. Fora de âmbito (follow-up)

- **Integridade de stock negativo** (−8 unidades, valores a zero na BD dev) — bug de
  captura de stock à parte; não bloqueia este trabalho.
- **Dashboard CAPEX/OPEX** (linhas mensais da empresa) — nível-empresa, não muda.
- **Validação de dedup** (avisar hardware lançado como investimento) — só faz sentido
  quando existirem dados de investimentos; fica como melhoria futura.

---

## 9. Pressupostos & riscos

- **Dedup por convenção:** assume que hardware/material é adquirido via stock e que
  investimentos não repetem essas compras. Sem dados para validar hoje; documentar no
  produto (ajuda/onboarding) para a disciplina se manter.
- **CAPEX rateado depende de `installed_clients`** estar correto nos investimentos (mesma
  dependência que o pool OPEX já tem).
- **Status dos investimentos:** só `ativo`/`em_execucao`/`recuperado` contam para custo;
  `planeado`/`cancelado` são excluídos (mudança face ao atual, que soma todos).

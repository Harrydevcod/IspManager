# Rentabilidade & Capital Investido — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refazer o cálculo de rentabilidade por cliente (modelo cash-recovery, separando capital recuperável de custos afundados, com equipamento devolvido a sair do investido e CAPEX rateado como o OPEX) e o total investido da empresa (CAPEX + stock adquirido, OPEX à parte), a partir de uma fonte única de cálculo.

**Architecture:** Duas libs novas — `lib/capital.ts` (contexto de rateio CAPEX + valor de stock adquirido, a espelhar `lib/opex.ts`) e `lib/profitability.ts` (`computeClientProfitability`, fonte única usada pelo endpoint de clientes e pelo export). O endpoint de investimentos passa a somar stock adquirido e a expor OPEX separado. UI de Clientes e Investimentos refletem as novas métricas. Entradas de stock passam a ser custeadas pelo landed cost do catálogo.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-06-06-rentabilidade-capital-investido-design.md`

---

## File Structure

| Ficheiro | Responsabilidade |
|---|---|
| `src/backend/lib/capital.ts` (novo) | `loadCompanyCapexContext()` (rateio CAPEX, totais) + `loadAcquiredStockValue()` (stock adquirido = entradas × landed). |
| `src/backend/lib/capital.test.ts` (novo) | Testes do contexto CAPEX e do valor de stock adquirido. |
| `src/backend/lib/profitability.ts` (novo) | `computeClientProfitability(clientId)` — fonte única da rentabilidade por cliente. |
| `src/backend/lib/profitability.test.ts` (novo) | Testes da fórmula (recuperável vs afundado, equipamento devolvido sai, rateio CAPEX). |
| `src/backend/routes/clients.ts` (mod) | Endpoint passa a delegar em `computeClientProfitability`. |
| `src/backend/routes/clients.test.ts` (mod) | Novos campos + cenário de devolução. |
| `src/backend/routes/investments.ts` (mod) | `totalInvestedCve` = CAPEX + stock adquirido; `totalOpexCve` separado. |
| `src/backend/routes/investments.test.ts` (mod) | Total investido inclui stock; OPEX separado. |
| `src/backend/routes/stock.ts` (mod) | Entradas custeadas pelo landed quando `unitCostCve` não é dado. |
| `src/backend/lib/profitability-export.ts` (mod) | Usa `computeClientProfitability`; reflete novos campos. |
| `src/renderer/types.ts` (mod) | Novos campos de `ClientProfitability` e dos totais de investimentos. |
| `src/renderer/modules/ClientsModule.tsx` (mod) | Grelha de Rentabilidade nova. |
| `src/renderer/modules/InvestmentsModule.tsx` (mod) | Total investido + OPEX à parte. |

---

## Task 1: `lib/capital.ts` — contexto CAPEX + stock adquirido

**Files:**
- Create: `src/backend/lib/capital.ts`
- Test: `src/backend/lib/capital.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/lib/capital.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let loadCompanyCapexContext: typeof import('./capital').loadCompanyCapexContext;
let loadAcquiredStockValue: typeof import('./capital').loadAcquiredStockValue;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-capital-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  const capital = await import('./capital');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  loadCompanyCapexContext = capital.loadCompanyCapexContext;
  loadAcquiredStockValue = capital.loadAcquiredStockValue;
});

beforeEach(() => {
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

function seedClient(code: string, zone: string | null) {
  return db.prepare(`INSERT INTO clients (client_code, full_name, zone, status) VALUES (?, ?, ?, 'active')`)
    .run(code, `Cliente ${code}`, zone).lastInsertRowid as number;
}

describe('loadCompanyCapexContext', () => {
  test('splits CAPEX into client-direct, zone, and unallocated pool (active only)', () => {
    const c1 = seedClient('C1', 'Praia');
    db.prepare(`INSERT INTO investments (name, type, client_id, investment_date, reference_month, status, installed_clients, total_cost_cve)
                VALUES ('Direto', 'cliente', ?, '2026-01-01', '2026-01', 'ativo', 1, 10000)`).run(c1);
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, status, installed_clients, total_cost_cve)
                VALUES ('Zona', 'zona', 'Praia', '2026-01-01', '2026-01', 'ativo', 2, 20000)`).run();
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, status, installed_clients, total_cost_cve)
                VALUES ('Infra', 'infraestrutura', '2026-01-01', '2026-01', 'ativo', 4, 40000)`).run();
    db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, status, installed_clients, total_cost_cve)
                VALUES ('Cancelado', 'outro', '2026-01-01', '2026-01', 'cancelado', 5, 99999)`).run();

    const ctx = loadCompanyCapexContext();
    expect(ctx.directByClient[c1]).toBe(10000);
    expect(ctx.directByZone['Praia']).toBe(20000);
    expect(ctx.unallocatedCapexCve).toBe(40000);
    // installed_clients of active investments: 1 + 2 + 4 = 7 (cancelado excluded)
    expect(ctx.totalInstalledActive).toBe(7);
    expect(ctx.capexPerClient).toBeCloseTo(40000 / 7, 5);
  });

  test('capexPerClient is 0 when no active installed clients', () => {
    const ctx = loadCompanyCapexContext();
    expect(ctx.capexPerClient).toBe(0);
  });
});

describe('loadAcquiredStockValue', () => {
  test('values entradas by catalog landed cost, ignoring movement unit_cost', () => {
    const cat = db.prepare(`INSERT INTO equipment_catalog
      (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, active)
      VALUES ('router', 'R1', 1000, 100, 50, 0, 0, 1)`).run().lastInsertRowid as number;
    // landed = 1150. unit_cost on movement is 0 (the unreliable field) — must be ignored.
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 5, 0)`).run(cat);
    db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'saida', 2, 0)`).run(cat);
    expect(loadAcquiredStockValue()).toBe(5 * 1150);
  });

  test('returns 0 with no entradas', () => {
    expect(loadAcquiredStockValue()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/lib/capital.test.ts`
Expected: FAIL — `Cannot find module './capital'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/lib/capital.ts`:

```ts
import { getSqliteDatabase } from '../db/database';
import { ACTIVE_INVESTMENT_STATUSES } from './opex';

/**
 * Pro-rata CAPEX context — the capital twin of loadCompanyOpexContext, but in
 * TOTALS (one-time capital), not monthly figures. Only investments with an
 * active status (ativo / em_execucao / recuperado) count; planeado / cancelado
 * are excluded.
 *
 * Allocation mirrors OPEX:
 *   - investment with client_id  -> 100% that client     (directByClient)
 *   - investment with zone only  -> directByZone[zone]    (split per active
 *                                    client in the zone at the consumption site)
 *   - investment with neither    -> unallocated pool, split per installed client
 *                                    -> capexPerClient
 */
export type CompanyCapexContext = {
  directByClient: Record<number, number>;
  directByZone: Record<string, number>;
  unallocatedCapexCve: number;
  totalInstalledActive: number;
  capexPerClient: number;
};

export function loadCompanyCapexContext(): CompanyCapexContext {
  const db = getSqliteDatabase();
  const rows = db.prepare(`
    SELECT client_id AS clientId, zone, status,
           installed_clients AS installedClients,
           total_cost_cve AS totalCostCve
    FROM investments
  `).all() as Array<{
    clientId: number | null; zone: string | null; status: string;
    installedClients: number; totalCostCve: number;
  }>;

  const directByClient: Record<number, number> = {};
  const directByZone: Record<string, number> = {};
  let unallocatedCapexCve = 0;
  let totalInstalledActive = 0;

  for (const r of rows) {
    if (!ACTIVE_INVESTMENT_STATUSES.has(r.status)) continue;
    totalInstalledActive += Number(r.installedClients) || 0;
    const cost = Number(r.totalCostCve) || 0;
    if (r.clientId != null) {
      directByClient[r.clientId] = (directByClient[r.clientId] || 0) + cost;
    } else if (r.zone) {
      directByZone[r.zone] = (directByZone[r.zone] || 0) + cost;
    } else {
      unallocatedCapexCve += cost;
    }
  }

  const capexPerClient = totalInstalledActive > 0 ? unallocatedCapexCve / totalInstalledActive : 0;
  return { directByClient, directByZone, unallocatedCapexCve, totalInstalledActive, capexPerClient };
}

/**
 * Capital spent acquiring inventory. Values every 'entrada' stock movement at
 * the catalog landed cost (purchase + shipping + customs + other), NOT the
 * movement's own unit_cost_cve — which is frequently 0 in real data.
 */
export function loadAcquiredStockValue(): number {
  const db = getSqliteDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(sm.quantity *
      (ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve)), 0) AS total
    FROM stock_movements sm
    JOIN equipment_catalog ec ON ec.id = sm.catalog_id
    WHERE sm.type = 'entrada'
  `).get() as { total: number };
  return Number(row.total) || 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/lib/capital.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/capital.ts src/backend/lib/capital.test.ts
git commit -m "feat(capital): CAPEX allocation context + acquired stock value"
```

---

## Task 2: `lib/profitability.ts` — computeClientProfitability

**Files:**
- Create: `src/backend/lib/profitability.ts`
- Test: `src/backend/lib/profitability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/lib/profitability.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

let app: FastifyInstance;
let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;
let computeClientProfitability: typeof import('./profitability').computeClientProfitability;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-prof-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  const prof = await import('./profitability');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
  computeClientProfitability = prof.computeClientProfitability;
});

beforeEach(() => {
  db.prepare('DELETE FROM service_install_costs').run();
  db.prepare('DELETE FROM service_material_lines').run();
  db.prepare('DELETE FROM service_device_assignments').run();
  db.prepare('DELETE FROM expenses').run();
  db.prepare('DELETE FROM investment_items').run();
  db.prepare('DELETE FROM investments').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM stock_movements').run();
  db.prepare('DELETE FROM services').run();
  db.prepare('DELETE FROM internet_plans').run();
  db.prepare('DELETE FROM equipment_catalog').run();
  db.prepare('DELETE FROM clients').run();
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_AUTH;
});

function seed() {
  const client = db.prepare(`INSERT INTO clients (client_code, full_name, zone, status) VALUES ('C1','Cliente 1','Praia','active')`).run().lastInsertRowid as number;
  const plan = db.prepare(`INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_cve) VALUES ('P','50','20','fibra',3500)`).run().lastInsertRowid as number;
  const service = db.prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status) VALUES (?, ?, 3500, '2026-01-15', 10, 'active')`).run(client, plan).lastInsertRowid as number;
  const cat = db.prepare(`INSERT INTO equipment_catalog (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, active) VALUES ('router','R1', 4000, 0, 0, 0, 10, 1)`).run().lastInsertRowid as number;
  return { client, plan, service, cat };
}

describe('computeClientProfitability', () => {
  test('active equipment counts as recoverable; returned equipment drops out', () => {
    const { client, service, cat } = seed();
    // One active assignment (end_date NULL) and one returned (end_date set).
    db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date) VALUES (?, ?, '2026-01-15', NULL)`).run(service, cat);
    db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date) VALUES (?, ?, '2026-01-15', '2026-02-01')`).run(service, cat);

    const p = computeClientProfitability(client);
    // Only the active one (landed 4000) is recoverable equipment.
    expect(p.recoverableEquipmentCve).toBe(4000);
  });

  test('materials and labour are sunk; total = recoverable + sunk', () => {
    const { client, service, cat } = seed();
    db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date) VALUES (?, ?, '2026-01-15', NULL)`).run(service, cat);
    db.prepare(`INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve) VALUES (?, ?, 10, 50)`).run(service, cat);
    db.prepare(`INSERT INTO service_install_costs (service_id, kind, amount_cve) VALUES (?, 'mao_de_obra', 1500)`).run(service);

    const p = computeClientProfitability(client);
    expect(p.materialsCostCve).toBe(500);
    expect(p.labourCostCve).toBe(1500);
    expect(p.sunkCostCve).toBe(2000);
    expect(p.recoverableEquipmentCve).toBe(4000);
    expect(p.capitalRecoverableCve).toBe(4000); // no CAPEX investments
    expect(p.totalInvestedCve).toBe(6000);
  });

  test('allocates zone CAPEX split across active clients in the zone', () => {
    const { client } = seed();
    // second active client in same zone
    db.prepare(`INSERT INTO clients (client_code, full_name, zone, status) VALUES ('C2','Cliente 2','Praia','active')`).run();
    db.prepare(`INSERT INTO investments (name, type, zone, investment_date, reference_month, status, installed_clients, total_cost_cve)
                VALUES ('Zona Praia','zona','Praia','2026-01-01','2026-01','ativo', 2, 20000)`).run();

    const p = computeClientProfitability(client);
    // 20000 / 2 active clients in zone = 10000 to this client.
    expect(p.allocatedCapexCve).toBe(10000);
    expect(p.capitalRecoverableCve).toBe(10000);
  });

  test('net profit = paid revenue − total invested − cumulative opex', () => {
    const { client, service, cat } = seed();
    db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date) VALUES (?, ?, '2026-01-15', NULL)`).run(service, cat);
    db.prepare(`INSERT INTO payments (client_id, status, amount_cve, due_date, payment_date, reference_month) VALUES (?, 'paid', 3500, '2026-02-10', '2026-02-09', '2026-02')`).run(client);
    db.prepare(`INSERT INTO payments (client_id, status, amount_cve, due_date, payment_date, reference_month) VALUES (?, 'paid', 3500, '2026-03-10', '2026-03-09', '2026-03')`).run(client);

    const p = computeClientProfitability(client);
    // No expenses -> cumulativeOpex 0. invested = 4000. paid = 7000. net = 3000.
    expect(p.cumulativeOpexCve).toBe(0);
    expect(p.totalInvestedCve).toBe(4000);
    expect(p.paidRevenueCve).toBe(7000);
    expect(p.netProfitCve).toBe(3000);
    expect(p.profitabilityPct).toBeCloseTo((3000 / 4000) * 100, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/lib/profitability.test.ts`
Expected: FAIL — `Cannot find module './profitability'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/lib/profitability.ts` (move + adapt the logic currently inline in `routes/clients.ts`):

```ts
import { getSqliteDatabase } from '../db/database';
import { addMonthsIso } from './dates';
import { loadCompanyOpexContext, type CompanyOpexContext } from './opex';
import { loadCompanyCapexContext } from './capital';

export type EquipmentUsedRow = {
  itemType: string;
  itemName: string;
  quantity: number;
  quantityUsed: number;
  totalCostCve: number;
};

export type ClientProfitability = {
  clientId: number;
  client: {
    id: number; clientCode: string; fullName: string;
    phone: string | null; island: string | null; zone: string | null; status: string;
  };
  // Capital model (cash-recovery)
  recoverableEquipmentCve: number;
  allocatedCapexCve: number;
  capitalRecoverableCve: number;
  materialsCostCve: number;
  labourCostCve: number;
  sunkCostCve: number;
  totalInvestedCve: number;
  /** @deprecated alias of totalInvestedCve, kept for older consumers */
  installationCostCve: number;
  investments: Array<{
    id: number; name: string; type: string; investmentDate: string;
    referenceMonth: string; status: string; zone: string | null; totalCostCve: number;
  }>;
  equipmentUsed: EquipmentUsedRow[];
  paidRevenueCve: number;
  pendingRevenueCve: number;
  monthsActive: number;
  paidMonths: number;
  monthlyAverageRevenueCve: number;
  imputedMonthlyOpexCve: number;
  directClientOpexCve: number;
  directZoneOpexCve: number;
  directInvestmentOpexCve: number;
  effectiveMonthlyOpexCve: number;
  cumulativeOpexCve: number;
  monthlyNetProfitCve: number;
  netProfitCve: number;
  monthsToBreakeven: number | null;
  projectedBreakevenDate: string | null;
  profitabilityPct: number | null;
  isRecovered: boolean;
  companyOpexShare: CompanyOpexContext;
};

export function computeClientProfitability(id: number): ClientProfitability | null {
  const db = getSqliteDatabase();

  const client = db.prepare(`
    SELECT id, client_code AS clientCode, full_name AS fullName, phone, island, zone, status
    FROM clients WHERE id = ?
  `).get(id) as ClientProfitability['client'] | undefined;
  if (!client) return null;

  const investmentRows = db.prepare(`
    SELECT id, name, type, investment_date AS investmentDate, reference_month AS referenceMonth,
           status, zone, total_cost_cve AS totalCostCve
    FROM investments
    WHERE client_id = ?
    ORDER BY investment_date ASC, id ASC
  `).all(id) as ClientProfitability['investments'];

  // Equipment currently deployed at the client (recoverable). end_date NULL only.
  const installedEquipmentUsed = db.prepare(`
    SELECT ec.type AS itemType,
           TRIM(COALESCE(ec.brand || ' ', '') || ec.model) AS itemName,
           COUNT(*) AS quantity,
           SUM(CASE WHEN a.end_date IS NULL THEN 1 ELSE 0 END) AS quantityUsed,
           SUM(CASE WHEN a.end_date IS NULL
                    THEN ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve
                    ELSE 0 END) AS totalCostCve
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = a.service_id
    WHERE s.client_id = ?
    GROUP BY ec.type, ec.brand, ec.model
    ORDER BY totalCostCve DESC, itemName ASC
  `).all(id) as EquipmentUsedRow[];

  const installedMaterialsUsed = db.prepare(`
    SELECT 'material' AS itemType,
           TRIM(COALESCE(ec.brand || ' ', '') || ec.model) AS itemName,
           SUM(ml.quantity) AS quantity,
           SUM(ml.quantity) AS quantityUsed,
           SUM(ml.quantity * ml.unit_cost_cve) AS totalCostCve
    FROM service_material_lines ml
    JOIN equipment_catalog ec ON ec.id = ml.catalog_id
    JOIN services s ON s.id = ml.service_id
    WHERE s.client_id = ?
    GROUP BY ec.id, ec.brand, ec.model
    ORDER BY totalCostCve DESC, itemName ASC
  `).all(id) as EquipmentUsedRow[];

  // Investment item detail only for client-direct investments.
  const investmentEquipmentUsed = investmentRows.length === 0 ? [] : db.prepare(`
    SELECT item_type AS itemType, item_name AS itemName,
           SUM(quantity) AS quantity, SUM(quantity_used) AS quantityUsed,
           SUM(total_cost_cve) AS totalCostCve
    FROM investment_items
    WHERE investment_id IN (${investmentRows.map(() => '?').join(',')})
    GROUP BY item_type, item_name
    ORDER BY totalCostCve DESC, itemName ASC
  `).all(...investmentRows.map((r) => r.id)) as EquipmentUsedRow[];

  const equipmentUsed = [...investmentEquipmentUsed, ...installedEquipmentUsed, ...installedMaterialsUsed]
    .reduce((items, row) => {
      const existing = items.find((i) => i.itemType === row.itemType && i.itemName === row.itemName);
      if (existing) {
        existing.quantity += Number(row.quantity || 0);
        existing.quantityUsed += Number(row.quantityUsed || 0);
        existing.totalCostCve += Number(row.totalCostCve || 0);
      } else {
        items.push({
          itemType: row.itemType, itemName: row.itemName,
          quantity: Number(row.quantity || 0), quantityUsed: Number(row.quantityUsed || 0),
          totalCostCve: Number(row.totalCostCve || 0)
        });
      }
      return items;
    }, [] as EquipmentUsedRow[])
    .sort((a, b) => b.totalCostCve - a.totalCostCve || a.itemName.localeCompare(b.itemName));

  // --- Capital model -------------------------------------------------------
  const recoverableEquipmentCve = installedEquipmentUsed.reduce((s, r) => s + Number(r.totalCostCve || 0), 0);

  const capexCtx = loadCompanyCapexContext();
  const capexDirectClient = capexCtx.directByClient[client.id] || 0;
  const capexZoneTotal = client.zone ? (capexCtx.directByZone[client.zone] || 0) : 0;
  const zoneActiveCount = client.zone
    ? (db.prepare(`SELECT COUNT(*) AS n FROM clients WHERE zone = ? AND status = 'active'`).get(client.zone) as { n: number }).n
    : 0;
  const capexZoneShare = zoneActiveCount > 0 ? capexZoneTotal / zoneActiveCount : 0;
  const allocatedCapexCve = capexDirectClient + capexZoneShare + capexCtx.capexPerClient;

  const capitalRecoverableCve = recoverableEquipmentCve + allocatedCapexCve;

  const materialsCostCve = installedMaterialsUsed.reduce((s, r) => s + Number(r.totalCostCve || 0), 0);
  const labourRow = db.prepare(`
    SELECT COALESCE(SUM(ic.amount_cve), 0) AS total
    FROM service_install_costs ic
    JOIN services s ON s.id = ic.service_id
    WHERE s.client_id = ?
  `).get(id) as { total: number };
  const labourCostCve = Number(labourRow.total || 0);
  const sunkCostCve = materialsCostCve + labourCostCve;

  const totalInvestedCve = capitalRecoverableCve + sunkCostCve;

  // --- Revenue & OPEX ------------------------------------------------------
  const payments = db.prepare(`
    SELECT id, status, amount_cve AS amountCve, due_date AS dueDate,
           payment_date AS paymentDate, reference_month AS referenceMonth
    FROM payments WHERE client_id = ? ORDER BY due_date ASC, id ASC
  `).all(id) as Array<{
    id: number; status: string; amountCve: number; dueDate: string;
    paymentDate: string | null; referenceMonth: string;
  }>;

  const paidRevenueCve = payments.filter((p) => p.status === 'paid').reduce((s, p) => s + Number(p.amountCve), 0);
  const pendingRevenueCve = payments
    .filter((p) => p.status === 'pending' || p.status === 'overdue')
    .reduce((s, p) => s + Number(p.amountCve), 0);
  const monthsActive = new Set(payments.map((p) => p.referenceMonth)).size;
  const paidMonths = new Set(payments.filter((p) => p.status === 'paid').map((p) => p.referenceMonth)).size;
  const monthlyAverageRevenueCve = paidMonths > 0 ? paidRevenueCve / paidMonths : 0;

  const opexCtx = loadCompanyOpexContext();
  const imputedMonthlyOpexCve = opexCtx.opexPerClientPerMonth;
  const directClientOpexCve = opexCtx.directByClient[client.id] || 0;
  const directZoneOpexCve = client.zone ? (opexCtx.directByZone[client.zone] || 0) : 0;
  const directZonePerClientCve = zoneActiveCount > 0 ? directZoneOpexCve / zoneActiveCount : 0;
  const directInvestmentOpexCve = investmentRows
    .reduce((sum, inv) => sum + (opexCtx.directByInvestment[inv.id] || 0), 0);
  const effectiveMonthlyOpexCve =
    imputedMonthlyOpexCve + directClientOpexCve + directZonePerClientCve + directInvestmentOpexCve;
  const cumulativeOpexCve = effectiveMonthlyOpexCve * monthsActive;
  const monthlyNetProfitCve = monthlyAverageRevenueCve - effectiveMonthlyOpexCve;
  const netProfitCve = paidRevenueCve - totalInvestedCve - cumulativeOpexCve;
  const monthsToBreakeven = monthlyNetProfitCve > 0 && totalInvestedCve > 0
    ? totalInvestedCve / monthlyNetProfitCve
    : null;
  const profitabilityPct = totalInvestedCve > 0 ? (netProfitCve / totalInvestedCve) * 100 : null;
  const isRecovered = totalInvestedCve > 0 && netProfitCve >= 0;

  const oldestPaidDate = payments
    .filter((p) => p.status === 'paid' && p.paymentDate)
    .map((p) => p.paymentDate!)
    .sort()[0] || null;
  const projectedBreakevenDate = (oldestPaidDate && monthsToBreakeven)
    ? addMonthsIso(oldestPaidDate, monthsToBreakeven)
    : null;

  return {
    clientId: client.id,
    client,
    recoverableEquipmentCve,
    allocatedCapexCve,
    capitalRecoverableCve,
    materialsCostCve,
    labourCostCve,
    sunkCostCve,
    totalInvestedCve,
    installationCostCve: totalInvestedCve,
    investments: investmentRows,
    equipmentUsed,
    paidRevenueCve,
    pendingRevenueCve,
    monthsActive,
    paidMonths,
    monthlyAverageRevenueCve,
    imputedMonthlyOpexCve,
    directClientOpexCve,
    directZoneOpexCve: directZonePerClientCve,
    directInvestmentOpexCve,
    effectiveMonthlyOpexCve,
    cumulativeOpexCve,
    monthlyNetProfitCve,
    netProfitCve,
    monthsToBreakeven,
    projectedBreakevenDate,
    profitabilityPct,
    isRecovered,
    companyOpexShare: opexCtx
  };
}
```

> NOTE on imports: confirm `addMonthsIso` lives in `./dates` by checking the
> existing import in `routes/clients.ts` (it imports `addMonthsIso`). If the path
> differs, copy the exact specifier from `routes/clients.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/lib/profitability.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/lib/profitability.ts src/backend/lib/profitability.test.ts
git commit -m "feat(profitability): single-source client profitability (recoverable vs sunk)"
```

---

## Task 3: Wire the clients endpoint to the shared function

**Files:**
- Modify: `src/backend/routes/clients.ts:48-233`
- Test: `src/backend/routes/clients.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/routes/clients.test.ts` inside a `describe('GET /api/clients/:id/profitability', ...)` block (create the block if absent):

```ts
describe('GET /api/clients/:id/profitability (capital model)', () => {
  test('returned equipment leaves recoverable capital and improves profit', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, zone, status) VALUES ('CP1','Cap','Praia','active')`).run().lastInsertRowid as number;
    const plan = db.prepare(`INSERT INTO internet_plans (name, download_speed, upload_speed, connection_type, monthly_price_cve) VALUES ('P','50','20','fibra',3500)`).run().lastInsertRowid as number;
    const service = db.prepare(`INSERT INTO services (client_id, plan_id, monthly_value_cve, activation_date, due_day, status) VALUES (?, ?, 3500, '2026-01-15', 10, 'active')`).run(client, plan).lastInsertRowid as number;
    const cat = db.prepare(`INSERT INTO equipment_catalog (type, model, purchase_price_cve, stock_total, active) VALUES ('router','R1', 4000, 10, 1)`).run().lastInsertRowid as number;
    const active = db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, start_date, end_date) VALUES (?, ?, '2026-01-15', NULL)`).run(service, cat).lastInsertRowid as number;
    db.prepare(`INSERT INTO payments (client_id, status, amount_cve, due_date, payment_date, reference_month) VALUES (?, 'paid', 3500, '2026-02-10', '2026-02-09', '2026-02')`).run(client);

    const before = await app.inject({ method: 'GET', url: `/api/clients/${client}/profitability` });
    const b = before.json() as { recoverableEquipmentCve: number; totalInvestedCve: number; netProfitCve: number };
    expect(b.recoverableEquipmentCve).toBe(4000);
    expect(b.totalInvestedCve).toBe(4000);
    expect(b.netProfitCve).toBe(3500 - 4000);

    // Return the equipment.
    db.prepare(`UPDATE service_device_assignments SET end_date = '2026-02-15' WHERE id = ?`).run(active);

    const after = await app.inject({ method: 'GET', url: `/api/clients/${client}/profitability` });
    const a = after.json() as { recoverableEquipmentCve: number; totalInvestedCve: number; netProfitCve: number };
    expect(a.recoverableEquipmentCve).toBe(0);
    expect(a.totalInvestedCve).toBe(0);
    expect(a.netProfitCve).toBe(3500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/clients.test.ts`
Expected: FAIL — `recoverableEquipmentCve` is `undefined` (endpoint still returns the old shape).

- [ ] **Step 3: Replace the endpoint body**

In `src/backend/routes/clients.ts`, replace the whole handler body (lines 48-233, from `app.get('/api/clients/:id/profitability'...` through its closing `});`) with:

```ts
  app.get('/api/clients/:id/profitability', { preHandler: requireAuth() }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Id invalido' });
    }
    const result = computeClientProfitability(id);
    if (!result) return reply.status(404).send({ error: 'Cliente nao encontrado' });
    return result;
  });
```

Add the import near the top of `src/backend/routes/clients.ts` (with the other imports):

```ts
import { computeClientProfitability } from '../lib/profitability';
```

Then remove now-unused imports from `clients.ts` that were only used by the deleted logic (e.g. `loadCompanyOpexContext`, `addMonthsIso`) — run typecheck (Step 4) to find them; delete exactly the ones flagged as unused.

- [ ] **Step 4: Run typecheck + the test**

Run: `npm.cmd run typecheck`
Expected: PASS (fix any unused-import errors by removing those imports).

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/clients.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/clients.ts src/backend/routes/clients.test.ts
git commit -m "refactor(clients): profitability endpoint delegates to shared function"
```

---

## Task 4: Frontend types + Clientes UI

**Files:**
- Modify: `src/renderer/types.ts:379-424`
- Modify: `src/renderer/modules/ClientsModule.tsx` (profitability grid ~ lines 372-426; footprint check)

- [ ] **Step 1: Update the type**

In `src/renderer/types.ts`, inside `export type ClientProfitability = { ... }`, replace the line
`  installationCostCve: number;` with these fields:

```ts
  recoverableEquipmentCve: number;
  allocatedCapexCve: number;
  capitalRecoverableCve: number;
  materialsCostCve: number;
  labourCostCve: number;
  sunkCostCve: number;
  totalInvestedCve: number;
  /** @deprecated alias of totalInvestedCve */
  installationCostCve: number;
```

- [ ] **Step 2: Update the footprint check**

In `src/renderer/modules/ClientsModule.tsx`, find the definition of `hasProfitabilityFootprint`
(search for `hasProfitabilityFootprint`). Replace its expression so it keys off the new total:

```ts
  const hasProfitabilityFootprint = !!profitability && (
    profitability.totalInvestedCve > 0
    || profitability.paidRevenueCve > 0
    || profitability.pendingRevenueCve > 0
  );
```

(If the current definition references `installationCostCve`, swap it for `totalInvestedCve`.)

- [ ] **Step 3: Replace the grid rows**

In `ClientsModule.tsx`, in the `<dl className="client-profitability-grid">`, replace the single
"Custo de instalacao" `<div>` (the block around lines 380-383) with:

```tsx
                  <div className="client-profitability-total">
                    <dt>Investimento total</dt>
                    <dd>{formatCve(profitability.totalInvestedCve)}</dd>
                    <small>recuperável {formatCve(profitability.capitalRecoverableCve)} · afundado {formatCve(profitability.sunkCostCve)}</small>
                  </div>
                  <div>
                    <dt>Capital recuperável</dt>
                    <dd>{formatCve(profitability.capitalRecoverableCve)}</dd>
                    <small>equip. {formatCve(profitability.recoverableEquipmentCve)} · CAPEX {formatCve(profitability.allocatedCapexCve)}</small>
                  </div>
                  <div>
                    <dt>Custos afundados</dt>
                    <dd>{formatCve(profitability.sunkCostCve)}</dd>
                    <small>materiais {formatCve(profitability.materialsCostCve)} · mão de obra {formatCve(profitability.labourCostCve)}</small>
                  </div>
```

- [ ] **Step 4: Verify renderer**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/types.ts src/renderer/modules/ClientsModule.tsx
git commit -m "feat(clients-ui): show recoverable capital vs sunk cost in profitability"
```

---

## Task 5: Investments totals — CAPEX + stock adquirido, OPEX separado

**Files:**
- Modify: `src/backend/routes/investments.ts:269-275` and the `totals` return object (~391-404)
- Test: `src/backend/routes/investments.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/routes/investments.test.ts` (mirror its existing setup):

```ts
test('total invested = CAPEX + acquired stock; OPEX is separate', async () => {
  // CAPEX investment
  db.prepare(`INSERT INTO investments (name, type, investment_date, reference_month, status, installed_clients, total_cost_cve)
              VALUES ('Infra','infraestrutura','2026-01-01','2026-01','ativo', 1, 30000)`).run();
  // Acquired stock: landed 1150 x 4 = 4600
  const cat = db.prepare(`INSERT INTO equipment_catalog (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, active)
              VALUES ('router','R1', 1000, 100, 50, 0, 4, 1)`).run().lastInsertRowid as number;
  db.prepare(`INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve) VALUES (?, 'entrada', 4, 0)`).run(cat);
  // Expense (OPEX) must NOT be in total invested
  db.prepare(`INSERT INTO expenses (name, amount_cve, reference_month) VALUES ('Renda', 5000, '2026-01')`).run();

  const res = await app.inject({ method: 'GET', url: '/api/investments' });
  const t = (res.json() as { totals: { totalInvestedCve: number; acquiredStockCve: number; allTimeCapexCve: number; totalOpexCve: number } }).totals;
  expect(t.allTimeCapexCve).toBe(30000);
  expect(t.acquiredStockCve).toBe(4600);
  expect(t.totalInvestedCve).toBe(34600);
  expect(t.totalOpexCve).toBe(5000);
});
```

> Check `investments.test.ts` for the exact `expenses` columns; if it has more
> NOT NULL columns, copy a working `INSERT INTO expenses` from elsewhere in that
> file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/investments.test.ts`
Expected: FAIL — `acquiredStockCve`/`totalOpexCve` undefined; `totalInvestedCve` still `30000 + 5000`.

- [ ] **Step 3: Update the totals computation**

In `src/backend/routes/investments.ts`, replace lines 269-275:

```ts
    const totalCostCve = rowsWithItems.reduce((sum, row) => sum + Number(row.totalCostCve || 0), 0);
    const totalExpensesCve = opexCtx.totalExpensesCve;
    const allTimeCapexRow = getSqliteDatabase()
      .prepare(`SELECT COALESCE(SUM(total_cost_cve), 0) AS totalCve FROM investments`)
      .get() as { totalCve: number };
    const allTimeCapexCve = Number(allTimeCapexRow.totalCve) || 0;
    const totalInvestedCve = allTimeCapexCve + totalExpensesCve;
```

with:

```ts
    const totalCostCve = rowsWithItems.reduce((sum, row) => sum + Number(row.totalCostCve || 0), 0);
    const totalExpensesCve = opexCtx.totalExpensesCve;
    const allTimeCapexRow = getSqliteDatabase()
      .prepare(`SELECT COALESCE(SUM(total_cost_cve), 0) AS totalCve FROM investments`)
      .get() as { totalCve: number };
    const allTimeCapexCve = Number(allTimeCapexRow.totalCve) || 0;
    const acquiredStockCve = loadAcquiredStockValue();
    // "Total investido" = capital (CAPEX infra + stock adquirido). OPEX is an
    // operating cost, surfaced separately, no longer folded into the total.
    const totalInvestedCve = allTimeCapexCve + acquiredStockCve;
    const totalOpexCve = totalExpensesCve;
```

Add the import near the top of `investments.ts`:

```ts
import { loadAcquiredStockValue } from '../lib/capital';
```

In the `totals: { ... }` return object (around line 393), add these three fields
(next to `totalInvestedCve`):

```ts
        allTimeCapexCve,
        acquiredStockCve,
        totalOpexCve,
```

- [ ] **Step 4: Run typecheck + the test**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/investments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/investments.ts src/backend/routes/investments.test.ts
git commit -m "feat(investments): total invested = CAPEX + acquired stock, OPEX separate"
```

---

## Task 6: Investments UI — total investido + OPEX à parte

**Files:**
- Modify: `src/renderer/modules/InvestmentsModule.tsx` (totals header ~ lines 413-428; the two `totals` default objects ~ lines 168, 238)

- [ ] **Step 1: Extend the totals type/defaults**

In `src/renderer/modules/InvestmentsModule.tsx`, both default `totals: { ... }` literals
(search for `totalInvestedCve: 0`) — add the new keys so the shape stays consistent:

```ts
        count: 0, totalCostCve: 0, totalExpensesCve: 0, totalInvestedCve: 0,
        allTimeCapexCve: 0, acquiredStockCve: 0, totalOpexCve: 0,
        investedByYear: [], monthlyNetProfitCve: 0, accumulatedProfitCve: 0,
        totalImputedOpexCve: 0, totalDirectOpexCve: 0, totalEffectiveOpexCve: 0,
        totalActualRevenueCve: 0, averageRoiPct: null, lowRoiCount: 0, notRecoveredCount: 0
```

If `InvestmentsModule.tsx` declares a local TS type for these totals, add
`allTimeCapexCve: number; acquiredStockCve: number; totalOpexCve: number;` to it.
If the totals are typed via `src/renderer/types.ts`, add the same three fields there.

- [ ] **Step 2: Update the header cards**

Find the "Total investido" card (around line 415):

```tsx
          <span>Total investido</span>
          <strong>{formatCve(data.totals.totalInvestedCve)}</strong>
```

Replace with (adds the breakdown sub-line and an OPEX card next to it):

```tsx
          <span>Total investido</span>
          <strong>{formatCve(data.totals.totalInvestedCve)}</strong>
          <small>CAPEX {formatCve(data.totals.allTimeCapexCve)} · stock {formatCve(data.totals.acquiredStockCve)}</small>
```

Then add a new card immediately after that card's closing element:

```tsx
        <div className="metric-card">
          <span>OPEX acumulado</span>
          <strong>{formatCve(data.totals.totalOpexCve)}</strong>
          <small>despesas operacionais</small>
        </div>
```

> Match the surrounding card markup exactly — copy the class names and wrapping
> element from the existing "Total investido" card (the snippet above shows the
> inner content; wrap it in the same container the neighbours use).

- [ ] **Step 3: Verify renderer**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/modules/InvestmentsModule.tsx src/renderer/types.ts
git commit -m "feat(investments-ui): total invested breakdown + separate OPEX card"
```

---

## Task 7: Cost stock entries by landed cost

**Files:**
- Modify: `src/backend/routes/stock.ts:277-312`
- Test: `src/backend/routes/stock.test.ts` (create the test block if the file lacks one for `/api/stock`)

- [ ] **Step 1: Write the failing test**

Add to `src/backend/routes/stock.test.ts` (mirror its setup; if the file does not
exist, create it following the `beforeAll`/`beforeEach` pattern from
`clients.test.ts`):

```ts
test("entrada with no unit cost is costed at catalog landed cost", async () => {
  const cat = db.prepare(`INSERT INTO equipment_catalog
    (type, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, stock_total, active)
    VALUES ('router','R1', 1000, 100, 50, 0, 0, 1)`).run().lastInsertRowid as number;

  const res = await app.inject({
    method: 'POST', url: '/api/stock',
    payload: { catalogId: cat, type: 'entrada', quantity: 3, unitCostCve: 0 }
  });
  expect(res.statusCode).toBe(201);

  const mv = db.prepare(`SELECT unit_cost_cve AS unitCostCve FROM stock_movements WHERE catalog_id = ? AND type = 'entrada'`).get(cat) as { unitCostCve: number };
  expect(mv.unitCostCve).toBe(1150); // landed cost
});
```

> Confirm the success status the route returns (`201` vs `200`) from
> `stock.ts` and align the assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: FAIL — stored `unit_cost_cve` is `0`.

- [ ] **Step 3: Default entrada cost to landed**

In `src/backend/routes/stock.ts`, change the catalog lookup (line 284) to also read
the landed cost:

```ts
    const catalog = db.prepare(`
      SELECT id, stock_total AS stockTotal,
             (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
      FROM equipment_catalog WHERE id = ?
    `).get(parsed.data.catalogId) as { id: number; stockTotal: number; landedCostCve: number } | undefined;
```

Before the transaction (after the stock guard, ~line 294), compute the effective cost:

```ts
    const effectiveUnitCostCve = (parsed.data.type === 'entrada' && !parsed.data.unitCostCve)
      ? Number(catalog.landedCostCve) || 0
      : parsed.data.unitCostCve;
```

In the `INSERT INTO stock_movements` call, replace the `parsed.data.unitCostCve`
argument with `effectiveUnitCostCve`.

- [ ] **Step 4: Run typecheck + the test**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/stock.ts src/backend/routes/stock.test.ts
git commit -m "feat(stock): cost stock entries at catalog landed cost when unset"
```

---

## Task 8: Export uses the shared function

**Files:**
- Modify: `src/backend/lib/profitability-export.ts`

- [ ] **Step 1: Inspect the export's per-client usage**

Read `src/backend/lib/profitability-export.ts` and locate where it computes or
references per-client profitability fields (it currently imports
`loadCompanyOpexContext` and rebuilds figures). Identify every field it reads.

- [ ] **Step 2: Replace per-client math with the shared function**

Where the export builds per-client profitability, call
`computeClientProfitability(clientId)` (import it) and read the fields from its
result. Map any old field it used:
- `installationCostCve` → still present (alias of `totalInvestedCve`), so existing
  references keep working; prefer `totalInvestedCve` for new labels.
- Add columns if useful: `capitalRecoverableCve`, `sunkCostCve` (optional).

Add the import:

```ts
import { computeClientProfitability } from './profitability';
```

> Keep changes minimal: the goal is that the export and the endpoint share one
> formula. If the export only needs company-level OPEX (not per-client), it may
> already be consistent — in that case only verify, no change needed.

- [ ] **Step 3: Verify**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd test -- --run --no-file-parallelism`
Expected: PASS (full suite).

- [ ] **Step 4: Commit**

```bash
git add src/backend/lib/profitability-export.ts
git commit -m "refactor(export): reuse shared client profitability function"
```

---

## Task 9: Full verification

- [ ] **Step 1: Typecheck + lint**

Run: `npm.cmd run typecheck`
Expected: PASS.

Run: `npm.cmd run lint`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `npm.cmd test -- --run --no-file-parallelism`
Expected: PASS (all files; new capital/profitability tests green).

- [ ] **Step 3: Manual smoke (Electron)**

Open a client with installed equipment → confirm "Investimento total",
"Capital recuperável", "Custos afundados" show and add up. Remove the equipment
→ recoverable drops, profit rises. Open Investimentos → "Total investido"
= CAPEX + stock, OPEX in its own card.

- [ ] **Step 4: Update memory**

Update `memory/ispm-rentabilidade-opex.md` and `MEMORY.md` to record the
cash-recovery capital model (recoverable vs sunk), CAPEX rateio mirroring OPEX,
acquired-stock in the company total, and the single-source `computeClientProfitability`.

---

## Self-Review Notes (covered)

- Spec §3 (per-client cash-recovery) → Tasks 2, 3, 4.
- Spec §3.3 (CAPEX rateio mirror OPEX) → Task 1 (`loadCompanyCapexContext`) + Task 2 (allocation).
- Spec §3.1 (returned equipment drops) → Task 2 test + Task 3 endpoint test.
- Spec §4 (company total = CAPEX + acquired stock, OPEX separate) → Tasks 1, 5, 6.
- Spec §4.1 (cost entradas by landed) → Task 7.
- Spec §5 (single source, no duplication) → Tasks 2, 3, 8.
- Spec §6 (UI) → Tasks 4, 6.
- Field names consistent across tasks: `recoverableEquipmentCve`, `allocatedCapexCve`,
  `capitalRecoverableCve`, `materialsCostCve`, `labourCostCve`, `sunkCostCve`,
  `totalInvestedCve`, and `acquiredStockCve`/`allTimeCapexCve`/`totalOpexCve`.

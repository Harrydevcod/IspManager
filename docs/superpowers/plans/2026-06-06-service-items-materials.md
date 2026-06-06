# Vários equipamentos + materiais por serviço — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir registar vários equipamentos serializados **e** materiais consumíveis (cabo, conectores…) por serviço, com abate de stock, BOM no histórico técnico e custo na rentabilidade do cliente.

**Architecture:** Catálogo unificado (`equipment_catalog` ganha `category`/`unit_of_measure`/`is_serialized`). Equipamento serializado continua em `service_device_assignments`; materiais entram numa nova `service_material_lines`. O motor partilhado `lib/serviceInstall.ts` (ex-`deviceInstall.ts`) valida e aplica um **lote** de itens numa única transação, abatendo stock e gerando um evento `instalacao` por lote.

**Tech Stack:** Node + Fastify + better-sqlite3 (migrações TS versionadas), Zod, Vitest; React + Vite (renderer, sem harness de testes unitários → verificação por typecheck/lint/smoke).

**Spec:** `docs/superpowers/specs/2026-06-06-service-items-materials-design.md`

**Comando de teste backend:** `npm.cmd test -- --run --no-file-parallelism <ficheiro>` (paralelismo desligado por flakiness do better-sqlite3).

---

## File Structure

- **Create:** `src/backend/db/migrations/0018_catalog_categories_materials.ts` — rebuild do catálogo + `service_material_lines`.
- **Rename:** `src/backend/lib/deviceInstall.ts` → `src/backend/lib/serviceInstall.ts` — motor partilhado (devices + materiais + lote).
- **Modify:** `src/backend/db/migrations/index.ts` — regista a 0018.
- **Modify:** `src/backend/routes/stock.ts` — `catalogSchema` + INSERT/UPDATE/summary com `category`/`unit_of_measure`/`is_serialized`.
- **Modify:** `src/backend/routes/finance.ts` — `POST /api/services` aceita `items[]`.
- **Modify:** `src/backend/routes/technical.ts` — `POST /api/services/:id/items` (lote, substitui `device-assignments` single); `technical-history` devolve `materials`.
- **Modify:** `src/backend/routes/clients.ts` — rentabilidade soma materiais.
- **Modify (tests):** `finance.test.ts`, `technical.test.ts`, `clients.test.ts`, `stock.test.ts` (criar se não existir, ver Task 2).
- **Modify (renderer):** `src/renderer/types.ts`, `src/renderer/modules/StockModule.tsx`, `src/renderer/modules/ServicesModule.tsx`, `src/renderer/modules/ClientsModule.tsx`, `src/renderer/styles.css`.

Cada Task produz uma mudança auto-contida e committável. Manter os 234 testes atuais verdes.

---

## Task 1: Migration 0018 — catálogo unificado + linhas de material

**Files:**
- Create: `src/backend/db/migrations/0018_catalog_categories_materials.ts`
- Modify: `src/backend/db/migrations/index.ts`
- Test: `src/backend/routes/stock.test.ts` (criado nesta task)

- [x] **Step 1: Escrever a migração**

Create `src/backend/db/migrations/0018_catalog_categories_materials.ts`:

```typescript
import type { Migration } from './types';

/**
 * Unifica o catálogo de stock para suportar materiais consumíveis a par dos
 * equipamentos serializados, e cria as linhas de consumo de material por serviço.
 *
 * `equipment_catalog` ganha:
 *   - category ('equipamento' | 'material')
 *   - unit_of_measure ('un', 'metro', 'caixa', ...)
 *   - is_serialized (equipamento=1, material=0)
 * e o CHECK de `type` passa a incluir subtipos de material ('cabo','conector',
 * 'ficha','suporte'). SQLite não altera CHECK in-place, por isso seguimos o
 * padrão de rebuild (create → copy → drop → rename), como em 0012. `equipment_catalog`
 * é referenciado por service_device_assignments e stock_movements com foreign_keys
 * ON em runtime; usamos PRAGMA defer_foreign_keys para validar no COMMIT, quando a
 * tabela já existe com os mesmos id.
 *
 * `service_material_lines` regista os materiais consumidos por serviço (quantidade,
 * sem série, sem end_date — material é consumido, não devolvido).
 */
const migration: Migration = {
  version: 18,
  name: 'catalog_categories_materials',
  sql: `
    PRAGMA defer_foreign_keys = ON;

    CREATE TABLE equipment_catalog_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'equipamento' CHECK(category IN ('equipamento','material')),
      type TEXT NOT NULL CHECK(type IN ('cpe','router','antena','switch','cabo','conector','ficha','suporte','outro')),
      brand TEXT,
      model TEXT NOT NULL,
      description TEXT,
      supplier TEXT,
      unit_of_measure TEXT NOT NULL DEFAULT 'un',
      is_serialized INTEGER NOT NULL DEFAULT 1,
      purchase_price_cve REAL NOT NULL DEFAULT 0,
      shipping_cost_cve REAL NOT NULL DEFAULT 0,
      customs_duty_cve REAL NOT NULL DEFAULT 0,
      other_costs_cve REAL NOT NULL DEFAULT 0,
      selling_price_cve REAL NOT NULL DEFAULT 0,
      rental_fee_cve REAL NOT NULL DEFAULT 0,
      stock_total INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO equipment_catalog_new (
      id, category, type, brand, model, description, supplier, unit_of_measure, is_serialized,
      purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
      selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
    )
    SELECT
      id, 'equipamento', type, brand, model, description, supplier, 'un', 1,
      purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
      selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
    FROM equipment_catalog;

    DROP TABLE equipment_catalog;
    ALTER TABLE equipment_catalog_new RENAME TO equipment_catalog;

    CREATE INDEX IF NOT EXISTS idx_eq_catalog_type ON equipment_catalog(type);
    CREATE INDEX IF NOT EXISTS idx_eq_catalog_category ON equipment_catalog(category);

    CREATE TABLE IF NOT EXISTS service_material_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_cost_cve REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_material_lines_service ON service_material_lines(service_id);
    CREATE INDEX IF NOT EXISTS idx_service_material_lines_catalog ON service_material_lines(catalog_id);

    CREATE TABLE IF NOT EXISTS service_install_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL REFERENCES services(id),
      kind TEXT NOT NULL CHECK(kind IN ('mao_de_obra','transporte','outro')),
      description TEXT,
      amount_cve REAL NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_service_install_costs_service ON service_install_costs(service_id);
  `
};

export default migration;
```

- [x] **Step 2: Registar a migração no index**

Modify `src/backend/db/migrations/index.ts`:
- Adicionar import após a linha do m0017:
  ```typescript
  import m0018 from './0018_catalog_categories_materials';
  ```
- Acrescentar `m0018` ao fim do array `migrations`:
  ```typescript
  export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018];
  ```

- [x] **Step 3: Escrever o teste de schema (falha primeiro)**

Create `src/backend/routes/stock.test.ts` (harness igual a finance.test.ts):

```typescript
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

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-stock-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  process.env.ISPM_AUTH = 'off';
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  db.exec(`
    DELETE FROM service_material_lines;
    DELETE FROM stock_movements;
    DELETE FROM equipment_catalog;
  `);
});

afterAll(async () => {
  await app.close();
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTH;
});

describe('catalog schema (0018)', () => {
  test('equipment rows default to serialized equipamento in units', () => {
    const id = db.prepare(`
      INSERT INTO equipment_catalog (type, brand, model, stock_total, active)
      VALUES ('router', 'MikroTik', 'hAP', 5, 1)
    `).run().lastInsertRowid as number;

    expect(db.prepare(`
      SELECT category, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'equipamento', unit: 'un', serialized: 1 });
  });

  test('accepts a material catalog row measured in metres', () => {
    const id = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material', 'cabo', 'Cabo UTP Cat6', 'metro', 0, 80, 305, 1)
    `).run().lastInsertRowid as number;

    expect(db.prepare(`
      SELECT category, type, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'material', type: 'cabo', unit: 'metro', serialized: 0 });
  });

  test('service_material_lines rejects non-positive quantity', () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-M','M','active')`).run().lastInsertRowid;
    const service = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 3500, 10, 'active')`).run(client).lastInsertRowid;
    const catalog = db.prepare(`INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total) VALUES ('material','cabo','UTP','metro',0,100)`).run().lastInsertRowid;

    expect(() => db.prepare(`
      INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve)
      VALUES (?, ?, 0, 80)
    `).run(service, catalog)).toThrow();
  });
});
```

> Nota: o `beforeEach` apaga `service_material_lines` antes de `stock_movements`/`equipment_catalog` (ordem child→parent por causa das FK ON em runtime).

- [x] **Step 4: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: FAIL — colunas `category`/`unit_of_measure`/`is_serialized` ou tabela `service_material_lines` não existem (a migração ainda não está registada/buildada). Se o melhor-sqlite3 reclamar de binário, correr `npm.cmd rebuild better-sqlite3` antes (gotcha conhecido).

- [x] **Step 5: Correr os testes para passar (migração já criada nos steps 1-2)**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: PASS (3 testes). Os Steps 1-2 já implementam o necessário; este step confirma.

- [x] **Step 6: Confirmar que a suite continua verde**

Run: `npm.cmd test -- --run --no-file-parallelism`
Expected: todos passam (234 + 3 novos). Se `migrate.test.ts` contar migrações, atualizar a contagem esperada para 18.

- [ ] **Step 7: Commit**

```bash
git add src/backend/db/migrations/0018_catalog_categories_materials.ts src/backend/db/migrations/index.ts src/backend/routes/stock.test.ts
git commit -m "feat(db): catalogo unificado (categoria/unidade/serializado) + service_material_lines"
```

---

## Task 2: Catálogo aceita categoria, unidade e serializado

**Files:**
- Modify: `src/backend/routes/stock.ts` (catalogSchema + INSERT + UPDATE + summary SELECT)
- Test: `src/backend/routes/stock.test.ts`

- [x] **Step 1: Escrever o teste (falha primeiro)**

Adicionar ao fim de `stock.test.ts`, antes do último `});` do ficheiro, um novo bloco:

```typescript
describe('POST /api/equipment-catalog with materials', () => {
  test('creates a material item with unit and category', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/equipment-catalog',
      payload: {
        category: 'material',
        type: 'cabo',
        model: 'Cabo UTP Cat6',
        unitOfMeasure: 'metro',
        isSerialized: false,
        purchasePriceCve: 80,
        stockTotal: 305
      }
    });

    expect(response.statusCode).toBe(201);
    const id = (response.json() as { id: number }).id;
    expect(db.prepare(`
      SELECT category, type, unit_of_measure AS unit, is_serialized AS serialized
      FROM equipment_catalog WHERE id = ?
    `).get(id)).toEqual({ category: 'material', type: 'cabo', unit: 'metro', serialized: 0 });
  });

  test('summary returns category, unit and isSerialized', async () => {
    db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active)
      VALUES ('material','conector','RJ45','un',0,200,1)
    `).run();

    const response = await app.inject({ method: 'GET', url: '/api/stock/summary' });
    const body = response.json() as { rows: Array<{ category: string; unitOfMeasure: string; isSerialized: number; model: string }> };
    const row = body.rows.find((r) => r.model === 'RJ45');
    expect(row).toMatchObject({ category: 'material', unitOfMeasure: 'un', isSerialized: 0 });
  });
});
```

- [x] **Step 2: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: FAIL — `catalogSchema` rejeita `category`/`unitOfMeasure`/`isSerialized` (campos desconhecidos são ignorados, mas a coluna não é gravada) e o summary não devolve esses campos.

- [x] **Step 3: Atualizar `catalogSchema`**

In `src/backend/routes/stock.ts`, substituir o `catalogSchema` por:

```typescript
const catalogSchema = z.object({
  category: z.enum(['equipamento', 'material']).default('equipamento'),
  type: z.enum(['cpe', 'router', 'antena', 'switch', 'cabo', 'conector', 'ficha', 'suporte', 'outro']),
  brand: z.string().trim().optional().nullable(),
  model: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
  supplier: z.string().trim().optional().nullable(),
  unitOfMeasure: z.string().trim().min(1).default('un'),
  isSerialized: z.coerce.boolean().default(true),
  purchasePriceCve: z.coerce.number().min(0).default(0),
  shippingCostCve: z.coerce.number().min(0).default(0),
  customsDutyCve: z.coerce.number().min(0).default(0),
  otherCostsCve: z.coerce.number().min(0).default(0),
  sellingPriceCve: z.coerce.number().min(0).default(0),
  rentalFeeCve: z.coerce.number().min(0).default(0),
  stockTotal: z.coerce.number().int().min(0).default(0),
  active: z.coerce.boolean().default(true)
});
```

- [x] **Step 4: Atualizar o INSERT (`POST /api/equipment-catalog`)**

Substituir o `db.prepare(...).run(...)` do POST por:

```typescript
    const result = db.prepare(`
      INSERT INTO equipment_catalog (
        category, type, brand, model, description, supplier, unit_of_measure, is_serialized,
        purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve,
        selling_price_cve, rental_fee_cve, stock_total, active, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      parsed.data.category,
      parsed.data.type,
      parsed.data.brand || null,
      parsed.data.model,
      parsed.data.description || null,
      parsed.data.supplier || null,
      parsed.data.unitOfMeasure,
      parsed.data.isSerialized ? 1 : 0,
      parsed.data.purchasePriceCve,
      parsed.data.shippingCostCve,
      parsed.data.customsDutyCve,
      parsed.data.otherCostsCve,
      parsed.data.sellingPriceCve,
      parsed.data.rentalFeeCve,
      parsed.data.stockTotal,
      parsed.data.active ? 1 : 0
    );
```

- [x] **Step 5: Atualizar o UPDATE (`PUT /api/equipment-catalog/:id`)**

Substituir o `UPDATE equipment_catalog SET ...` e respetivo `.run(...)` por:

```typescript
    const result = db.prepare(`
      UPDATE equipment_catalog
      SET category = ?,
          type = ?,
          brand = ?,
          model = ?,
          description = ?,
          supplier = ?,
          unit_of_measure = ?,
          is_serialized = ?,
          purchase_price_cve = ?,
          shipping_cost_cve = ?,
          customs_duty_cve = ?,
          other_costs_cve = ?,
          selling_price_cve = ?,
          rental_fee_cve = ?,
          stock_total = ?,
          active = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      parsed.data.category,
      parsed.data.type,
      parsed.data.brand || null,
      parsed.data.model,
      parsed.data.description || null,
      parsed.data.supplier || null,
      parsed.data.unitOfMeasure,
      parsed.data.isSerialized ? 1 : 0,
      parsed.data.purchasePriceCve,
      parsed.data.shippingCostCve,
      parsed.data.customsDutyCve,
      parsed.data.otherCostsCve,
      parsed.data.sellingPriceCve,
      parsed.data.rentalFeeCve,
      parsed.data.stockTotal,
      parsed.data.active ? 1 : 0,
      id
    );
```

- [x] **Step 6: Atualizar o SELECT do summary**

No `GET /api/stock/summary`, acrescentar três colunas ao SELECT (logo após `id,`):

```sql
        id,
        category,
        type,
        brand,
        model,
        description,
        supplier,
        unit_of_measure AS unitOfMeasure,
        is_serialized AS isSerialized,
        purchase_price_cve AS purchasePriceCve,
```

(o resto das colunas mantém-se).

- [x] **Step 7: Correr o teste — deve passar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/stock.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 8: Commit**

```bash
git add src/backend/routes/stock.ts src/backend/routes/stock.test.ts
git commit -m "feat(stock): catalogo aceita categoria, unidade de medida e serializado"
```

---

## Task 3: Renomear `deviceInstall.ts` → `serviceInstall.ts`

**Files:**
- Rename: `src/backend/lib/deviceInstall.ts` → `src/backend/lib/serviceInstall.ts`
- Modify: `src/backend/routes/technical.ts`, `src/backend/routes/finance.ts` (imports)

- [x] **Step 1: Renomear o ficheiro (preservando histórico)**

```bash
git mv src/backend/lib/deviceInstall.ts src/backend/lib/serviceInstall.ts
```

- [x] **Step 2: Atualizar os imports**

Em `src/backend/routes/technical.ts` e `src/backend/routes/finance.ts`, mudar:
```typescript
from '../lib/deviceInstall'
```
para:
```typescript
from '../lib/serviceInstall'
```

- [x] **Step 3: Typecheck**

Run: `npm.cmd run typecheck`
Expected: limpo (sem referências a `deviceInstall`).

- [x] **Step 4: Correr os testes afetados**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts src/backend/routes/finance.test.ts`
Expected: PASS (sem regressão — só mudou o nome).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(install): renomeia deviceInstall para serviceInstall"
```

---

## Task 4: Motor de consumo de material + preflight de lote

**Files:**
- Modify: `src/backend/lib/serviceInstall.ts`
- Test: (coberto pelos testes de endpoint nas Tasks 5-6; este task só adiciona funções puras)

- [x] **Step 1: Adicionar tipos de item e o consumo de material**

Em `src/backend/lib/serviceInstall.ts`, após o tipo `DeviceInput`, acrescentar:

```typescript
export type ServiceItemInput = DeviceInput & { quantity?: number | null };

export type CatalogKind = {
  id: number;
  isSerialized: number;
  stockTotal: number;
  landedCostCve: number;
};

export function loadCatalogKind(db: Database.Database, id: number): CatalogKind | undefined {
  return db.prepare(`
    SELECT
      id,
      is_serialized AS isSerialized,
      stock_total AS stockTotal,
      (purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve) AS landedCostCve
    FROM equipment_catalog
    WHERE id = ?
  `).get(id) as CatalogKind | undefined;
}
```

- [x] **Step 2: Adicionar `consumeMaterialWithinTx`**

No mesmo ficheiro, após `installDeviceWithinTx`, acrescentar:

```typescript
/**
 * Consome um material (não serializado) para um serviço, dentro de uma transação:
 * regista a linha de material, o movimento de stock 'saida' (quantidade N) e abate
 * o stock. Re-valida o stock para segurança de corrida.
 */
export function consumeMaterialWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; catalogId: number; quantity: number; notes?: string | null; userId: number | null }
): { lineId: number | bigint } {
  const { serviceId, clientName, catalogId, quantity, userId } = params;
  const notes = cleanValue(params.notes);

  const fresh = loadCatalogKind(db, catalogId);
  if (!fresh) {
    throw new Error('catalog_missing');
  }
  if (fresh.stockTotal < quantity) {
    throw new Error(`stock_insufficient:${fresh.stockTotal}`);
  }

  const line = db.prepare(`
    INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve, notes, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(serviceId, catalogId, quantity, fresh.landedCostCve, notes, userId);

  db.prepare(`
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by)
    VALUES (?, 'saida', ?, ?, ?, ?, ?, ?, ?)
  `).run(catalogId, quantity, fresh.landedCostCve, `Instalacao servico ${serviceId}`, notes, serviceId, clientName, userId);

  db.prepare(`
    UPDATE equipment_catalog SET stock_total = stock_total - ?, updated_at = datetime('now') WHERE id = ?
  `).run(quantity, catalogId);

  return { lineId: line.lastInsertRowid };
}
```

- [x] **Step 3: Adicionar `preflightItems` (valida um lote antes da transação)**

No mesmo ficheiro, após `preflightDeviceInstall`, acrescentar:

```typescript
export type ItemsPreflight =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Valida um lote de itens (equipamentos serializados + materiais) antes de abrir
 * a transação. Para serializados reaproveita preflightDeviceInstall; para materiais
 * exige quantity > 0 e stock suficiente. Devolve no primeiro erro encontrado.
 */
export function preflightItems(db: Database.Database, items: ServiceItemInput[]): ItemsPreflight {
  if (items.length === 0) {
    return { ok: false, status: 400, error: 'Nenhum item indicado' };
  }
  for (const item of items) {
    const kind = loadCatalogKind(db, item.catalogId);
    if (!kind) {
      return { ok: false, status: 404, error: 'Modelo nao encontrado' };
    }
    if (kind.isSerialized) {
      const result = preflightDeviceInstall(db, item);
      if (!result.ok) {
        return result;
      }
    } else {
      const quantity = Number(item.quantity ?? 0);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return { ok: false, status: 400, error: 'Quantidade de material invalida' };
      }
      if (kind.stockTotal < quantity) {
        return { ok: false, status: 400, error: `Stock insuficiente. Disponivel: ${kind.stockTotal}` };
      }
    }
  }
  return { ok: true };
}
```

- [x] **Step 4: Adicionar `installItemsWithinTx` (aplica o lote + 1 evento)**

No mesmo ficheiro, no fim, acrescentar:

```typescript
/**
 * Aplica um lote de itens a um serviço, DENTRO de uma transação. Equipamentos
 * serializados → service_device_assignments (qty 1 por linha); materiais →
 * service_material_lines. Gera UM evento 'instalacao' por lote.
 */
export function installItemsWithinTx(
  db: Database.Database,
  params: { serviceId: number; clientName: string; items: ServiceItemInput[]; userId: number | null }
): { assignmentIds: Array<number | bigint>; materialLineIds: Array<number | bigint>; eventId: number | bigint } {
  const { serviceId, clientName, items, userId } = params;
  const assignmentIds: Array<number | bigint> = [];
  const materialLineIds: Array<number | bigint> = [];

  for (const item of items) {
    const kind = loadCatalogKind(db, item.catalogId);
    if (!kind) {
      throw new Error('catalog_missing');
    }
    if (kind.isSerialized) {
      const { assignmentId } = installDeviceWithinTx(db, { serviceId, clientName, device: item, userId, skipEvent: true });
      assignmentIds.push(assignmentId);
    } else {
      const { lineId } = consumeMaterialWithinTx(db, {
        serviceId, clientName, catalogId: item.catalogId, quantity: Number(item.quantity ?? 1), notes: item.notes, userId
      });
      materialLineIds.push(lineId);
    }
  }

  const summary = `Instalou ${assignmentIds.length} equipamento(s) e ${materialLineIds.length} material(is)`;
  const technicianId = items.find((i) => i.technicianId)?.technicianId ?? null;
  const event = db.prepare(`
    INSERT INTO service_events (service_id, event_type, notes, technician_id, created_by, created_at)
    VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
  `).run(serviceId, summary, technicianId, technicianId);

  return { assignmentIds, materialLineIds, eventId: event.lastInsertRowid };
}
```

- [x] **Step 5: Tornar o evento opcional em `installDeviceWithinTx`**

Para evitar 1 evento por equipamento quando chamado em lote, dar a `installDeviceWithinTx` um parâmetro `skipEvent`. Modificar a assinatura e o corpo:

- Assinatura: `params: { serviceId: number; clientName: string; device: DeviceInput; userId: number | null; skipEvent?: boolean }`
- Antes do bloco que insere o `service_events`, envolver:
  ```typescript
  let eventId: number | bigint = 0;
  if (!params.skipEvent) {
    const event = db.prepare(`
      INSERT INTO service_events (
        service_id, event_type, notes, technician_id, created_by, created_at
      )
      VALUES (?, 'instalacao', ?, ?, ?, datetime('now'))
    `).run(serviceId, notes, technicianId, technicianId);
    eventId = event.lastInsertRowid;
  }
  return { assignmentId: assignment.lastInsertRowid, eventId };
  ```
  (o `return` substitui o atual). Chamadores existentes (single device em finance/technical) não passam `skipEvent` → comportamento inalterado.

- [x] **Step 6: Typecheck**

Run: `npm.cmd run typecheck`
Expected: limpo.

- [x] **Step 7: Garantir testes existentes verdes**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts src/backend/routes/finance.test.ts`
Expected: PASS (nada mudou no comportamento single-device; só adicionámos funções novas).

- [ ] **Step 8: Commit**

```bash
git add src/backend/lib/serviceInstall.ts
git commit -m "feat(install): motor de consumo de material e instalacao em lote"
```

---

## Task 5: `POST /api/services` aceita `items[]`

**Files:**
- Modify: `src/backend/routes/finance.ts`
- Test: `src/backend/routes/finance.test.ts`

- [x] **Step 1: Escrever o teste (falha primeiro)**

Substituir, em `finance.test.ts`, os dois testes `creates a service and installs equipment in one transaction` e `rolls back the new service when equipment is out of stock` por versões baseadas em `items`, e acrescentar um teste de material. Inserir este bloco no lugar deles (dentro do `describe('finance routes', ...)`):

```typescript
  test('creates a service and installs multiple items (device + material) atomically', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-DEV','Cliente Device','active')`).run();
    const router = db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, purchase_price_cve, shipping_cost_cve, customs_duty_cve, other_costs_cve, is_serialized, stock_total, active)
      VALUES ('equipamento','router','MikroTik','hAP ax2', 6000, 400, 200, 0, 1, 5, 1)
    `).run();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro', 0, 80, 305, 1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, serialNumber: 'SN-DEV-1' },
          { catalogId: cable.lastInsertRowid, quantity: 30 }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: number; assignmentIds: number[]; materialLineIds: number[]; eventId: number };
    expect(body.assignmentIds).toHaveLength(1);
    expect(body.materialLineIds).toHaveLength(1);

    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 4 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 275 });
    expect(db.prepare('SELECT quantity AS q, unit_cost_cve AS u FROM service_material_lines WHERE service_id = ?').get(body.id)).toEqual({ q: 30, u: 80 });
    // um unico evento de instalacao por lote
    expect(db.prepare("SELECT count(*) AS n FROM service_events WHERE service_id = ? AND event_type = 'instalacao'").get(body.id)).toEqual({ n: 1 });
  });

  test('rolls back the whole service when one item is out of stock', async () => {
    const client = db.prepare(`INSERT INTO clients (client_code, full_name, status) VALUES ('CLT-NS','Sem Stock','active')`).run();
    const router = db.prepare(`INSERT INTO equipment_catalog (category, type, model, is_serialized, stock_total, active) VALUES ('equipamento','router','R1',1,5,1)`).run();
    const cable = db.prepare(`INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active) VALUES ('material','cabo','UTP','metro',0,10,1)`).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/services',
      payload: {
        clientId: client.lastInsertRowid,
        monthlyValueCve: 3500,
        dueDay: 10,
        items: [
          { catalogId: router.lastInsertRowid, serialNumber: 'SN-OK' },
          { catalogId: cable.lastInsertRowid, quantity: 50 }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 10' });
    expect(db.prepare('SELECT count(*) AS n FROM services WHERE client_id = ?').get(client.lastInsertRowid)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM service_device_assignments').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM stock_movements').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(router.lastInsertRowid)).toEqual({ s: 5 });
  });
```

- [x] **Step 2: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/finance.test.ts`
Expected: FAIL — `POST /api/services` ainda só conhece `device` (singular), não `items`.

- [x] **Step 3: Atualizar o schema e o handler em `finance.ts`**

Substituir o import do motor por:
```typescript
import { installItemsWithinTx, mapInstallError, preflightItems, type ServiceItemInput } from '../lib/serviceInstall';
```

Substituir `deviceInstallSchema` + o campo `device` por um schema de itens:

```typescript
const serviceItemSchema = z.object({
  catalogId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().optional().nullable(),
  serialNumber: z.string().trim().optional().nullable(),
  assetTag: z.string().trim().optional().nullable(),
  ipAddress: z.string().trim().optional().nullable(),
  macAddress: z.string().trim().optional().nullable(),
  technicianId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().optional().nullable()
});
```
e no `serviceSchema` trocar `device: deviceInstallSchema.optional().nullable()` por:
```typescript
  items: z.array(serviceItemSchema).optional().nullable()
```

Substituir o bloco de preflight + transação do handler `POST /api/services` por:

```typescript
    const items = (parsed.data.items ?? []) as ServiceItemInput[];
    if (items.length > 0) {
      const preflight = preflightItems(db, items);
      if (!preflight.ok) {
        return reply.status(preflight.status).send({ error: preflight.error });
      }
    }

    const run = db.transaction(() => {
      const inserted = db.prepare(`
        INSERT INTO services (
          client_id, plan_id, monthly_value_cve, activation_date, due_day,
          status, technical_notes, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        parsed.data.clientId,
        parsed.data.planId || null,
        parsed.data.monthlyValueCve,
        parsed.data.activationDate || null,
        parsed.data.dueDay,
        parsed.data.status,
        parsed.data.technicalNotes || null
      );
      const serviceId = Number(inserted.lastInsertRowid);

      const install = items.length > 0
        ? installItemsWithinTx(db, { serviceId, clientName: client.fullName, items, userId: request.user?.id ?? null })
        : null;

      return { serviceId, install };
    });

    let created: { serviceId: number; install: ReturnType<typeof installItemsWithinTx> | null };
    try {
      created = run();
    } catch (error) {
      const mapped = mapInstallError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }

    recordAudit(request, {
      action: 'create',
      entityType: 'service',
      entityId: created.serviceId,
      summary: `Criou servico para cliente ${parsed.data.clientId}`,
      metadata: { clientId: parsed.data.clientId, planId: parsed.data.planId ?? null, status: parsed.data.status }
    });
    if (created.install) {
      recordAudit(request, {
        action: 'assign_device',
        entityType: 'service',
        entityId: created.serviceId,
        summary: `Instalou itens ao criar o servico ${created.serviceId}`,
        metadata: { items: items.length }
      });
    }
    return reply.status(201).send({
      id: created.serviceId,
      ...(created.install ?? {})
    });
```

> Garantir que `client` continua a ser obtido com `full_name AS fullName` (já está da Task PR#9). Remover o `deviceInstallSchema` agora não usado.

- [x] **Step 4: Correr o teste — deve passar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/finance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/finance.ts src/backend/routes/finance.test.ts
git commit -m "feat(services): POST /api/services aceita lote de itens (equipamento + material)"
```

---

## Task 6: `POST /api/services/:id/items` (lote) substitui `device-assignments`

**Files:**
- Modify: `src/backend/routes/technical.ts`
- Test: `src/backend/routes/technical.test.ts`

- [x] **Step 1: Escrever o teste (falha primeiro)**

Em `technical.test.ts`, acrescentar dentro do `describe('technical routes', ...)`:

```typescript
  test('installs a batch of items (device + material) on an existing service', async () => {
    const { catalog, service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,80,100,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: {
        items: [
          { catalogId: catalog.lastInsertRowid, serialNumber: 'SN-B1' },
          { catalogId: cable.lastInsertRowid, quantity: 25 }
        ]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { assignmentIds: number[]; materialLineIds: number[]; eventId: number };
    expect(body.assignmentIds).toHaveLength(1);
    expect(body.materialLineIds).toHaveLength(1);
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(catalog.lastInsertRowid)).toEqual({ s: 9 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 75 });
    expect(db.prepare("SELECT count(*) AS n FROM service_events WHERE service_id = ? AND event_type='instalacao'").get(service.lastInsertRowid)).toEqual({ n: 1 });
  });

  test('rejects the batch when material stock is insufficient (no side effects)', async () => {
    const { catalog, service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, stock_total, active)
      VALUES ('material','cabo','UTP','metro',0,5,1)
    `).run();

    const response = await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [ { catalogId: cable.lastInsertRowid, quantity: 10 } ] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Stock insuficiente. Disponivel: 5' });
    expect(db.prepare('SELECT count(*) AS n FROM service_material_lines').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT stock_total AS s FROM equipment_catalog WHERE id = ?').get(cable.lastInsertRowid)).toEqual({ s: 5 });
  });
```

**Migrar TODOS os testes que batem em `device-assignments`** (o endpoint single deixa de existir). Em `technical.test.ts` são três:
- `creates a device assignment and records the installation event` → POST `/items` com `{ items: [ { catalogId, serialNumber: 'SN-001', assetTag: 'AST-001', ipAddress, macAddress, technicianId, notes } ] }`; asserções de resposta passam a `assignmentIds: [<n>]` + `eventId`; manter a verificação do `technical-history` (assignment continua a aparecer).
- `rejects assignment when stock is not available` → POST `/items` com `{ items: [ { catalogId, serialNumber: 'SN-NOSTOCK' } ] }`; continua 400 `Stock insuficiente. Disponivel: 0` e zero assignments.
- `rejects a duplicate active serial` (409) → POST `/items` com o serial repetido; continua 409 `Serial ja esta atribuido a outro equipamento ativo`.

O teste `replaces an active assignment in one transaction` mantém-se (usa `device-replacement`, inalterado).

- [x] **Step 2: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts`
Expected: FAIL — rota `/items` não existe.

- [x] **Step 3: Substituir o handler `device-assignments` por `items`**

Em `technical.ts`:
- Atualizar o import do motor para incluir o lote:
  ```typescript
  import {
    installItemsWithinTx,
    loadCatalogIdentity,
    mapInstallError,
    preflightItems,
    type ServiceItemInput
  } from '../lib/serviceInstall';
  ```
- Substituir todo o handler `app.post('/api/services/:id/device-assignments', ...)` por:

```typescript
  const batchItemsSchema = z.object({
    items: z.array(z.object({
      catalogId: z.coerce.number().int().positive(),
      quantity: z.coerce.number().int().positive().optional().nullable(),
      serialNumber: z.string().trim().optional().nullable(),
      assetTag: z.string().trim().optional().nullable(),
      ipAddress: z.string().trim().optional().nullable(),
      macAddress: z.string().trim().optional().nullable(),
      technicianId: z.coerce.number().int().positive().optional().nullable(),
      notes: z.string().trim().optional().nullable()
    })).min(1)
  });

  app.post('/api/services/:id/items', canWriteTechnical, async (request, reply) => {
    const serviceId = Number((request.params as { id: string }).id);
    const parsed = batchItemsSchema.safeParse(request.body);
    if (!Number.isInteger(serviceId) || serviceId <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de instalacao invalidos' });
    }

    const db = getSqliteDatabase();
    const service = loadService(serviceId);
    if (!service) {
      return reply.status(404).send({ error: 'Servico nao encontrado' });
    }

    const items = parsed.data.items as ServiceItemInput[];
    const preflight = preflightItems(db, items);
    if (!preflight.ok) {
      return reply.status(preflight.status).send({ error: preflight.error });
    }

    const run = db.transaction(() => installItemsWithinTx(db, {
      serviceId,
      clientName: service.clientName,
      items,
      userId: request.user?.id ?? null
    }));

    let result: ReturnType<typeof installItemsWithinTx>;
    try {
      result = run();
    } catch (error) {
      const mapped = mapInstallError(error);
      if (mapped) {
        return reply.status(mapped.status).send({ error: mapped.error });
      }
      throw error;
    }

    recordAudit(request, {
      action: 'assign_device',
      entityType: 'service',
      entityId: serviceId,
      summary: `Instalou ${items.length} item(s) no servico ${serviceId}`,
      metadata: { items: items.length, eventId: result.eventId }
    });
    return reply.status(201).send(result);
  });
```

> O handler de troca (`device-replacement`) e os seus imports (`installDeviceWithinTx`, `loadCatalogIdentity`, `preflightDeviceInstall`, `cleanValue`) mantêm-se. Remover imports que deixem de ser usados (verificar com typecheck/lint).

- [x] **Step 4: Correr os testes — devem passar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/technical.ts src/backend/routes/technical.test.ts
git commit -m "feat(technical): endpoint /items em lote substitui device-assignments single"
```

---

## Task 7: `technical-history` devolve materiais

**Files:**
- Modify: `src/backend/routes/technical.ts` (handler `GET .../technical-history`)
- Test: `src/backend/routes/technical.test.ts`

- [x] **Step 1: Escrever o teste (falha primeiro)**

Em `technical.test.ts`, acrescentar:

```typescript
  test('technical-history returns materials alongside assignments', async () => {
    const { service } = seedBaseService();
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro',0,80,100,1)
    `).run();
    await app.inject({
      method: 'POST',
      url: `/api/services/${service.lastInsertRowid}/items`,
      payload: { items: [ { catalogId: cable.lastInsertRowid, quantity: 20 } ] }
    });

    const history = await app.inject({ method: 'GET', url: `/api/services/${service.lastInsertRowid}/technical-history` });
    const body = history.json() as { materials: Array<{ model: string; quantity: number; unitOfMeasure: string }> };
    expect(body.materials).toHaveLength(1);
    expect(body.materials[0]).toMatchObject({ model: 'Cabo UTP', quantity: 20, unitOfMeasure: 'metro' });
  });
```

- [x] **Step 2: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts`
Expected: FAIL — `materials` é `undefined`.

- [x] **Step 3: Adicionar a query de materiais ao handler**

No handler `GET /api/services/:id/technical-history`, antes do `return`, acrescentar:

```typescript
    const materials = db.prepare(`
      SELECT
        ml.id,
        ml.catalog_id AS catalogId,
        ec.type AS catalogType,
        ec.brand,
        ec.model,
        ec.unit_of_measure AS unitOfMeasure,
        ml.quantity,
        ml.unit_cost_cve AS unitCostCve,
        ml.notes,
        ml.created_at AS createdAt,
        cu.full_name AS createdByName
      FROM service_material_lines ml
      JOIN equipment_catalog ec ON ec.id = ml.catalog_id
      LEFT JOIN users cu ON cu.id = ml.created_by
      WHERE ml.service_id = ?
      ORDER BY ml.created_at DESC, ml.id DESC
    `).all(id);
```

e mudar o `return` para:

```typescript
    return { serviceId: service.id, assignments, materials, events };
```

- [x] **Step 4: Correr o teste — deve passar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/technical.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/technical.ts src/backend/routes/technical.test.ts
git commit -m "feat(technical): technical-history inclui materiais consumidos"
```

---

## Task 8: Rentabilidade soma materiais

**Files:**
- Modify: `src/backend/routes/clients.ts`
- Test: `src/backend/routes/clients.test.ts`

- [x] **Step 1: Escrever o teste (falha primeiro)**

Em `clients.test.ts`, acrescentar (a seguir ao teste de equipamento instalado já existente):

```typescript
  test('profitability includes materials consumed on services', async () => {
    const clientId = db.prepare(`INSERT INTO clients (client_code, full_name, phone, status) VALUES ('CLT-MAT','Cliente Material','9444444','active')`).run().lastInsertRowid as number;
    const serviceId = db.prepare(`INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 4500, 10, 'active')`).run(clientId).lastInsertRowid as number;
    const cable = db.prepare(`
      INSERT INTO equipment_catalog (category, type, model, unit_of_measure, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('material','cabo','Cabo UTP','metro',0,80,1000,1)
    `).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO service_material_lines (service_id, catalog_id, quantity, unit_cost_cve) VALUES (?, ?, 50, 80)`).run(serviceId, cable);

    const response = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/profitability` });
    const body = response.json() as { installationCostCve: number; equipmentUsed: Array<{ itemName: string; quantity: number; totalCostCve: number }> };
    expect(body.installationCostCve).toBe(4000); // 50 * 80
    expect(body.equipmentUsed).toContainEqual(expect.objectContaining({ itemName: 'Cabo UTP', quantity: 50, totalCostCve: 4000 }));
  });
```

- [x] **Step 2: Correr o teste — deve falhar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/clients.test.ts`
Expected: FAIL — materiais não contam para `installationCostCve`/`equipmentUsed`.

- [x] **Step 3: Adicionar a query de materiais à rentabilidade**

Em `clients.ts`, no handler de profitability, após o cálculo de `installedEquipmentUsed`, acrescentar:

```typescript
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
    `).all(id) as Array<{
      itemType: string; itemName: string; quantity: number; quantityUsed: number; totalCostCve: number;
    }>;
```

Mudar a linha que constrói `equipmentUsed` para incluir os materiais:

```typescript
    const equipmentUsed = [...investmentEquipmentUsed, ...installedEquipmentUsed, ...installedMaterialsUsed]
      .reduce((items, row) => {
```

E mudar o cálculo do custo:

```typescript
    const installedMaterialsCostCve = installedMaterialsUsed
      .reduce((sum, row) => sum + Number(row.totalCostCve || 0), 0);
    const installationCostCve = investmentCostCve + installedEquipmentCostCve + installedMaterialsCostCve;
```

- [x] **Step 4: Correr o teste — deve passar**

Run: `npm.cmd test -- --run --no-file-parallelism src/backend/routes/clients.test.ts`
Expected: PASS.

- [x] **Step 5: Suite completa verde**

Run: `npm.cmd test -- --run --no-file-parallelism`
Expected: todos passam.

- [ ] **Step 6: Commit**

```bash
git add src/backend/routes/clients.ts src/backend/routes/clients.test.ts
git commit -m "feat(clients): rentabilidade soma materiais consumidos por servico"
```

---

## Task 9: Tipos do renderer

**Files:**
- Modify: `src/renderer/types.ts`

- [x] **Step 1: Atualizar `StockCatalogRow`**

Substituir o tipo `StockCatalogRow` por (adiciona `category`, `unitOfMeasure`, `isSerialized` e alarga `type`):

```typescript
export type StockCatalogRow = {
  id: number;
  category: 'equipamento' | 'material';
  type: 'cpe' | 'router' | 'antena' | 'switch' | 'cabo' | 'conector' | 'ficha' | 'suporte' | 'outro';
  brand: string | null;
  model: string;
  supplier: string | null;
  unitOfMeasure: string;
  isSerialized: number;
  purchasePriceCve: number;
  sellingPriceCve: number;
  rentalFeeCve: number;
  stockTotal: number;
  active: number;
  landedCostCve: number;
  lastMovementAt: string | null;
};
```

- [x] **Step 2: Adicionar `MaterialLine` e estender `TechnicalHistory`**

Após o tipo `DeviceAssignment`, acrescentar:

```typescript
export type MaterialLine = {
  id: number;
  catalogId: number;
  catalogType: string;
  brand: string | null;
  model: string;
  unitOfMeasure: string;
  quantity: number;
  unitCostCve: number;
  notes: string | null;
  createdAt: string;
};
```

e mudar `TechnicalHistory` para:

```typescript
export type TechnicalHistory = {
  serviceId: number;
  assignments: DeviceAssignment[];
  materials: MaterialLine[];
  events: ServiceEvent[];
};
```

- [x] **Step 3: Typecheck (vai apontar consumidores a ajustar)**

Run: `npm.cmd run typecheck`
Expected: erros nos módulos que ainda não tratam os novos campos — resolvidos nas Tasks 10-12. Se preferes commit limpo, faz esta task junto com a 10.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/types.ts
git commit -m "feat(types): catalogo com categoria/unidade/serializado + linhas de material"
```

---

## Task 10: StockModule — criar materiais

**Files:**
- Modify: `src/renderer/modules/StockModule.tsx`

> Sem harness de testes de renderer → verificação por `typecheck` + `lint` + smoke manual.

- [x] **Step 1: Adicionar `category`, `unitOfMeasure`, `isSerialized` ao formulário do catálogo**

No estado do formulário do catálogo de `StockModule.tsx`, acrescentar os campos `category: 'equipamento'`, `unitOfMeasure: 'un'`, `isSerialized: true` (valores por defeito). No corpo do formulário:
- Um `Select` "Categoria" (equipamento/material). Ao escolher `material`, pôr `isSerialized=false` por defeito.
- Um `Field` "Unidade" (texto, ex.: un, metro, caixa).
- Um `Toggle` "Serializado (serial/MAC por unidade)".
- Alargar o `Select` de "Tipo" para incluir `cabo`, `conector`, `ficha`, `suporte`.

No payload do POST/PUT, incluir `category`, `unitOfMeasure`, `isSerialized`. Carregar estes campos ao editar uma linha existente (a partir de `StockCatalogRow`).

- [x] **Step 2: Typecheck + lint**

Run: `npm.cmd run typecheck` e `npm.cmd run lint`
Expected: limpos.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/modules/StockModule.tsx
git commit -m "feat(stock-ui): formulario do catalogo cria materiais (categoria/unidade/serializado)"
```

---

## Task 11: Builder de itens (criação + diálogo "Adicionar")

**Files:**
- Modify: `src/renderer/modules/ServicesModule.tsx`
- Modify: `src/renderer/styles.css`

- [x] **Step 1: Modelar o estado de linhas**

Em `ServicesModule.tsx`, definir um tipo de linha de instalação e estado de lista (substitui `newServiceDevice`/`deviceForm` por um array reutilizável):

```typescript
type ItemDraft = {
  catalogId: string;       // '' até escolher
  quantity: string;        // só usado se material
  serialNumber: string;
  assetTag: string;
  ipAddress: string;
  macAddress: string;
  notes: string;
};

function emptyItemDraft(): ItemDraft {
  return { catalogId: '', quantity: '1', serialNumber: '', assetTag: '', ipAddress: '', macAddress: '', notes: '' };
}
```

Estado: `const [itemDrafts, setItemDrafts] = useState<ItemDraft[]>([]);` (para o formulário de criação) e o mesmo para o diálogo "Adicionar".

- [x] **Step 2: UI do builder**

Para cada `ItemDraft` renderizar uma linha: `Select` do catálogo (rotular `{model} · {type} · {stockTotal} {unitOfMeasure}`). Resolver o item escolhido em `catalogList` (já carregado via `ensureCatalogLoaded`). Se `item.isSerialized` → mostrar serial/MAC/IP/asset (quantidade fixa 1); senão → mostrar `Field` "Quantidade" (number, min 1, max `stockTotal`). Botão "Remover linha" e, abaixo da lista, "Adicionar item" (`setItemDrafts((d) => [...d, emptyItemDraft()])`). Envolver num contentor `.service-items-builder` (reutilizar/renomear o `.service-equipment-section` existente).

- [x] **Step 3: Construir o payload `items[]`**

Função que converte `itemDrafts` válidos (com `catalogId`) em `items` para o backend:

```typescript
function buildItemsPayload(drafts: ItemDraft[], catalog: StockCatalogRow[]) {
  return drafts
    .filter((d) => d.catalogId)
    .map((d) => {
      const item = catalog.find((c) => String(c.id) === d.catalogId);
      const serialized = item?.isSerialized !== 0;
      return serialized
        ? {
            catalogId: Number(d.catalogId),
            serialNumber: d.serialNumber || null,
            assetTag: d.assetTag || null,
            ipAddress: d.ipAddress || null,
            macAddress: d.macAddress || null,
            notes: d.notes || null
          }
        : { catalogId: Number(d.catalogId), quantity: Number(d.quantity || 1), notes: d.notes || null };
    });
}
```

- [x] **Step 4: Ligar à criação de serviço**

Em `saveService`, ao criar (`!editingService`), substituir o antigo `device` por `items: buildItemsPayload(itemDrafts, catalogList)` (omitir a chave se vazio). Validar: se há rascunhos com `catalogId` mas algum material com quantidade < 1 → toast de erro. Mensagem de sucesso reflete itens instalados.

- [x] **Step 5: Ligar ao diálogo "Adicionar" (pós-criação)**

Substituir `submitDeviceAssignment` (que fazia POST a `device-assignments`) por um submit que faz `POST /api/services/:id/items` com `{ items: buildItemsPayload(addItemDrafts, catalogList) }`. Recarregar `loadTechnicalHistory` no sucesso. Renomear o botão/título do diálogo para "Adicionar itens".

- [x] **Step 6: Estilos**

Em `styles.css`, renomear `.service-equipment-section` → `.service-items-builder` (e a referência no JSX) e acrescentar regras para as linhas (cada linha em grelha, botão remover discreto, divisória entre linhas). Manter `grid-column: 1 / -1` no formulário.

- [x] **Step 7: Typecheck + lint**

Run: `npm.cmd run typecheck` e `npm.cmd run lint`
Expected: limpos.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/modules/ServicesModule.tsx src/renderer/styles.css
git commit -m "feat(services-ui): builder de itens (varios equipamentos + materiais) na criacao e no Adicionar"
```

---

## Task 12: Histórico técnico mostra materiais

**Files:**
- Modify: `src/renderer/modules/ServicesModule.tsx`

- [x] **Step 1: Renderizar o grupo "Materiais"**

No painel de detalhe do serviço, abaixo da secção "Equipamentos", acrescentar uma secção "Materiais" que lista `technicalHistory.materials` (cada item: `{brand} {model}`, `{quantity} {unitOfMeasure}`, custo `formatCve(unitCostCve * quantity)`). Mostrar `EmptyState` "Sem materiais registados" quando vazio.

- [x] **Step 2: Typecheck + lint**

Run: `npm.cmd run typecheck` e `npm.cmd run lint`
Expected: limpos.

- [x] **Step 3: Smoke manual (renderer + backend isolado)**

Iniciar a app e verificar o fluxo end-to-end:
1. Stock → criar um material "Cabo UTP" (categoria material, unidade metro, não serializado, stock 305).
2. Serviços → Novo serviço → adicionar 1 router (com serial) + 30 m de cabo → gravar.
3. Confirmar: stock do router −1, cabo −30; detalhe do serviço mostra Equipamentos + Materiais; rentabilidade do cliente inclui o custo do cabo.
4. No detalhe, "Adicionar itens" → mais 1 material → confirmar abate e histórico.

Concluído em 2026-06-06 com Chromium/Playwright contra uma base SQLite temporária:
- router: stock `1 → 0`;
- cabo: stock `305 → 275 → 270`;
- histórico: `1` equipamento ativo, `2` linhas de material (`35 metro` no total);
- mão de obra: `2.500 + 500 = 3.000 CVE`;
- rentabilidade: `installationCostCve = 11.800` (equipamento `6.000` + material `2.800` + mão de obra `3.000`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/modules/ServicesModule.tsx
git commit -m "feat(services-ui): histórico técnico mostra materiais consumidos"
```

---

## Fase 2 — Custos de instalação (mão de obra) + abas do Stock

> **Estado: implementada e committed** (commits `f515009`, `21238e3`, `72708e2`). 249 testes verdes, typecheck+lint limpos. Falta apenas o smoke manual no Electron. As Tasks 13–16 abaixo ficam como registo do que foi feito.
>
> A migração 0018 já tinha criado `service_install_costs`; ligámo-la de ponta a ponta (motor → endpoints → rentabilidade → tipos → UI) e separámos o Stock em duas abas. Cada Task foi TDD-first e committável.

### Task 13: Stock — abas Equipamentos | Materiais

**Files:** `src/renderer/modules/StockModule.tsx` (typecheck/lint + smoke; sem harness de testes de renderer)

- [ ] **Step 1:** Estado `stockTab: 'equipamento' | 'material'` (default `'equipamento'`). Renderizar um seletor de abas (mesmo padrão visual dos restantes módulos). Filtrar `catalogList` por `row.category === stockTab` para a tabela. O botão "Novo" pré-seleciona a `category` da aba ativa e ajusta `isSerialized` (equipamento→true, material→false) por defeito.
- [ ] **Step 2:** Ajustar colunas por aba: materiais mostram **Unidade** e ocultam colunas só-de-equipamento que não façam sentido (ex.: serial). Manter contagem/realce de stock baixo nas duas.
- [ ] **Step 3:** `npm.cmd run typecheck` + `npm.cmd run lint` limpos.
- [ ] **Step 4:** Commit — `feat(stock-ui): abas Equipamentos e Materiais no catalogo`.

### Task 14: Motor + endpoints aceitam `installCosts[]`

**Files:** `src/backend/lib/serviceInstall.ts`, `src/backend/routes/finance.ts`, `src/backend/routes/technical.ts`, `finance.test.ts`, `technical.test.ts`

- [ ] **Step 1 (teste falha):** Em `finance.test.ts`, `POST /api/services` com `installCosts: [{ kind:'mao_de_obra', amountCve: 2500 }]` grava 1 linha em `service_install_costs` (mesma transação; rollback se algo falhar). Em `technical.test.ts`, `POST /:id/items` com `installCosts` idem.
- [ ] **Step 2:** Em `serviceInstall.ts` adicionar:
  ```typescript
  export type InstallCostInput = { kind?: 'mao_de_obra' | 'transporte' | 'outro'; description?: string | null; amountCve: number };

  export function insertInstallCostsWithinTx(
    db: Database.Database,
    params: { serviceId: number; costs: InstallCostInput[]; userId: number | null }
  ): { installCostIds: Array<number | bigint> } {
    const ids: Array<number | bigint> = [];
    for (const c of params.costs) {
      const res = db.prepare(`
        INSERT INTO service_install_costs (service_id, kind, description, amount_cve, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(params.serviceId, c.kind ?? 'mao_de_obra', cleanValue(c.description), Number(c.amountCve || 0), params.userId);
      ids.push(res.lastInsertRowid);
    }
    return { installCostIds: ids };
  }
  ```
- [ ] **Step 3:** Schema Zod `installCostSchema` (`kind` enum default `mao_de_obra`, `description?`, `amountCve` ≥ 0) e campo `installCosts: z.array(...).optional().nullable()` em ambos os handlers. Chamar `insertInstallCostsWithinTx` **dentro da mesma transação** (após items, se houver). Custos são independentes de items — aceitar mesmo com `items` vazio (serviço só com mão de obra).
- [ ] **Step 4:** Devolver `installCostIds` na resposta. Testes passam.
- [ ] **Step 5:** Commit — `feat(install): endpoints aceitam custos de instalacao (mao de obra)`.

### Task 15: technical-history + rentabilidade incluem custos de instalação

**Files:** `src/backend/routes/technical.ts`, `src/backend/routes/clients.ts`, `technical.test.ts`, `clients.test.ts`

- [ ] **Step 1 (teste falha):** `technical-history` devolve `installCosts: [{ kind, description, amountCve, createdAt }]`. Rentabilidade soma `service_install_costs.amount_cve` em `installationCostCve` (teste: 1 serviço com 2500 mão de obra → `installationCostCve` inclui 2500).
- [ ] **Step 2:** Em `technical.ts` query `service_install_costs WHERE service_id = ?` e incluir no `return { serviceId, assignments, materials, installCosts, events }`.
- [ ] **Step 3:** Em `clients.ts` profitability somar `SUM(amount_cve)` de `service_install_costs` (join via `services.client_id`) a `installationCostCve`. Manter `equipmentUsed` inalterado (mão de obra não é "item" físico — soma só ao custo).
- [ ] **Step 4:** Testes passam; suite completa verde.
- [ ] **Step 5:** Commit — `feat(clients): rentabilidade inclui mao de obra; historico expõe custos de instalacao`.

### Task 16: Tipos + UI (campo "Mão de obra" + grupo Custos)

**Files:** `src/renderer/types.ts`, `src/renderer/modules/ServicesModule.tsx`

- [ ] **Step 1:** Em `types.ts`: `export type InstallCost = { id: number; kind: 'mao_de_obra'|'transporte'|'outro'; description: string | null; amountCve: number; createdAt: string };` e `TechnicalHistory.installCosts: InstallCost[]`.
- [ ] **Step 2:** Na criação de serviço e no diálogo "Adicionar itens": campo **"Mão de obra (CVE)"** (number, ≥ 0). Se > 0, juntar `installCosts: [{ kind:'mao_de_obra', amountCve }]` ao payload. (Opcional: campo de descrição livre.)
- [ ] **Step 3:** No detalhe do serviço, grupo **"Custos de instalação"** abaixo de Materiais: lista `technicalHistory.installCosts` (`{kind legível} · {description}` → `formatCve(amountCve)`) com total. `EmptyState` "Sem custos registados" quando vazio.
- [ ] **Step 4:** `npm.cmd run typecheck` + `npm.cmd run lint` limpos.
- [ ] **Step 5:** Commit — `feat(services-ui): mao de obra na instalacao + grupo de custos no detalhe`.

---

## Verificação final

- [x] `npm.cmd run typecheck` limpo
- [x] `npm.cmd run lint` limpo
- [x] `npm.cmd test -- --run --no-file-parallelism` — todos verdes (249)
- [x] Atualizar memória do projeto: [[ispm-service-create-with-device]] reflete lote de itens + materiais + mão de obra, catálogo unificado, abas do Stock, `service_material_lines`/`service_install_costs`.
- [x] Smoke manual (Task 12 Step 3 + fluxo de mão de obra/abas) concluído

## Notas de execução

- **better-sqlite3 binário:** se algum teste falhar com erro de binário nativo, correr `npm.cmd rebuild better-sqlite3` antes (gotcha conhecido após builds do electron-builder).
- **Limpezas de teste FK-safe:** novas tabelas filhas (`service_material_lines`, `service_install_costs`) têm de ser apagadas **antes** das pais nos `beforeEach` (FK ON em runtime).
- **Contrato `device` → `items`:** qualquer chamada antiga a `device-assignments` single ou ao campo `device` foi substituída; garantir que nada no renderer ainda os usa (grep `device-assignments`, `device:` no payload).
- **`installCosts[]` independente de `items`:** ambos os endpoints (`POST /api/services` e `/items`) aceitam custos sem itens (serviço só com mão de obra). Mão de obra soma ao `installationCostCve` mas **não** entra em `equipmentUsed` (não é item físico).

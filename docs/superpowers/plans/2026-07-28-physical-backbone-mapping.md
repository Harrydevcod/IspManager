# Physical Backbone Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a default Backbone management tab that persists physical CPE-to-backbone relationships and makes the existing Topologia tab render only those explicit relationships.

**Architecture:** Add physical `backbone_devices` and temporal `backbone_assignment_links` tables, expose a focused management API, and replace the topology read model's catalog inference with explicit active links. A tab shell owns mutation revision and focus state; the management workspace is editable for admin/operator and read-only for technicians, while the existing React Flow canvas remains lazy and read-only.

**Tech Stack:** TypeScript 5.7, React 19, Fastify 5, Zod 3, SQLite/better-sqlite3, Vitest, React Flow 12, Dagre 3, CSS.

## Global Constraints

- Preserve every existing uncommitted Topology change; never reset, checkout, or overwrite it.
- The module opens on **Backbone**; **Topologia** is second.
- The canvas may render only persisted active links, never catalog or quantity inference.
- Every assignment has at most one active backbone link.
- Read access: `admin`, `operator`, `technician`; write access: `admin`, `operator`.
- Migrated backbone units are provisional and receive no invented serial, IP, MAC, location, or CPE link.
- `backbone_qty` is removed after lossless conversion and cannot remain a second source of truth.
- No automatic Stock movement is created when a backbone device is added.
- No ping, SNMP, LLDP, reachability, or online/offline claim is introduced.
- All mutation routes validate with Zod, use parameterized SQL, run state transitions transactionally, and write audit events.
- Keep React Flow and Dagre outside the initial application chunk.
- Follow TDD: observe each focused test fail before implementing its production change.

## Execution preflight

The current worktree contains the completed, verified first Topology implementation.
Before Task 1, preserve it in one baseline commit so later task commits remain
reviewable:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
git add package.json package-lock.json src/backend/routes/auth.test.ts src/backend/server.ts src/renderer/App.tsx src/renderer/App.topology.test.tsx src/renderer/modules/ServicesModule.tsx src/renderer/modules/StockModule.tsx src/renderer/modules/topology src/renderer/types.ts src/shared/topology.ts src/backend/lib/topology-read-model.ts src/backend/lib/topology-search.ts src/backend/routes/topology.ts src/backend/routes/topology.test.ts docs/adr/0004-topology-inventory-lineage-read-model.md reviews
git commit -m "feat(topology): add factual inventory topology"
```

Expected: all checks pass and `git status --short` contains no pre-existing Topology
implementation files. Do not stage unrelated user files if any appear.

---

## File structure

### Persistence and contracts

- Create `src/backend/db/migrations/0031_physical_backbone_mapping.ts` — immutable
  schema/data migration from catalog quantities to physical devices while retaining
  the legacy column for intermediate compatibility.
- Modify `src/backend/db/migrations/index.ts` — register migration 31, then migration
  32 when Task 4 removes the legacy column.
- Modify `src/backend/db/schema.ts` — Drizzle declarations for both new tables and
  removal of `backboneQty`.
- Modify `src/backend/db/migrate.test.ts` — migration preservation and constraint
  tests.
- Create `src/shared/backbone.ts` — management API types shared by backend/renderer.
- Modify `src/shared/topology.ts` — physical backbone node and explicit relationship
  contracts.

### Backend

- Create `src/backend/lib/backbone-management.ts` — queries, normalization, and
  transactional association state changes.
- Create `src/backend/lib/backbone-management.test.ts` — repository-level invariants.
- Create `src/backend/routes/topology-management.ts` — authenticated CRUD, search,
  RBAC, conflict mapping, and audit.
- Create `src/backend/routes/topology-management.test.ts` — HTTP contract tests.
- Modify `src/backend/server.ts` — route registration.
- Modify `src/backend/lib/topology-read-model.ts` — explicit physical nodes/links.
- Modify `src/backend/lib/topology-search.ts` — physical backbone search/ancestors.
- Modify `src/backend/routes/topology.test.ts` — revised snapshot/branch/search facts.
- Modify `src/backend/routes/technical.ts` — close active topology links when an
  assignment is replaced or returned.
- Modify `src/backend/routes/technical.test.ts` — lifecycle integration tests.
- Modify `src/backend/routes/investments.ts` and
  `src/backend/routes/investments.test.ts` — derive backbone capital from physical
  devices.
- Modify `src/backend/routes/stock.ts` and `src/backend/routes/stock.test.ts` — remove
  legacy quantity input/output.

### Renderer

- Create `src/renderer/modules/topology/backbone-api.ts` — typed HTTP client.
- Create `src/renderer/modules/topology/useBackboneWorkspace.ts` — list/detail/search
  state and mutations.
- Create `src/renderer/modules/topology/BackboneWorkspace.tsx` — management view.
- Create `src/renderer/modules/topology/BackboneList.tsx` — searchable/paginated
  master list.
- Create `src/renderer/modules/topology/BackboneDetail.tsx` — identity and linked CPEs.
- Create `src/renderer/modules/topology/BackboneDialogs.tsx` — create/edit/link/
  transfer/unlink interactions.
- Create `src/renderer/modules/topology/BackboneWorkspace.css` — responsive split view.
- Create `src/renderer/modules/topology/BackboneWorkspace.test.tsx` — integrated
  workspace, dialog, permissions, keyboard, and responsive-state tests.
- Create `src/renderer/modules/topology/TopologyMapView.tsx` — existing map extracted
  without behavior loss.
- Modify `src/renderer/modules/topology/TopologyModule.tsx` — accessible tab shell,
  invalidation revision, and cross-tab focus.
- Modify `src/renderer/modules/topology/TopologyModule.css` — module-level tabs.
- Modify existing topology canvas, inspector, toolbar, fixtures, and tests for physical
  backbone fields and `defined_link`.
- Modify `src/renderer/modules/StockModule.tsx` and `src/renderer/types.ts` — remove
  legacy backbone quantity UI/contracts while preserving catalog focus navigation.
- Modify `src/renderer/App.topology.test.tsx` — default tab and lazy map integration.

### Documentation

- Create `docs/adr/0005-explicit-physical-backbone-links.md` — supersede ADR 0004.
- Modify `docs/adr/0004-topology-inventory-lineage-read-model.md` — mark superseded.
- Modify `reviews/topology-review.md` — final review evidence.

---

### Task 1: Physical backbone migration and schema

**Files:**
- Create: `src/backend/db/migrations/0031_physical_backbone_mapping.ts`
- Modify: `src/backend/db/migrations/index.ts`
- Modify: `src/backend/db/schema.ts`
- Modify: `src/backend/db/migrate.test.ts`

**Interfaces:**
- Consumes: `Migration` from `src/backend/db/migrations/types.ts`.
- Produces: tables `backbone_devices`, `backbone_assignment_links`; retains
  `equipment_catalog.backbone_qty` until Task 4 so every intermediate commit passes.

- [ ] **Step 1: Add a failing migration preservation test**

Add a test that migrates a database containing one catalog with
`backbone_qty = 2`, then asserts:

```ts
expect(db.prepare(`
  SELECT name, provisional, serial_number AS serialNumber
  FROM backbone_devices
  ORDER BY id
`).all()).toEqual([
  { name: 'Ubiquiti Rocket Prism #1', provisional: 1, serialNumber: null },
  { name: 'Ubiquiti Rocket Prism #2', provisional: 1, serialNumber: null }
]);
expect(db.prepare(`PRAGMA table_info(equipment_catalog)`).all())
  .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'backbone_qty' })]));
```

Also assert `PRAGMA foreign_key_check` is empty.

- [ ] **Step 2: Run the focused migration test and observe failure**

Run:

```powershell
npx.cmd vitest run src/backend/db/migrate.test.ts
```

Expected: FAIL because migration 31 and `backbone_devices` do not exist.

- [ ] **Step 3: Implement migration 31**

Create the migration with:

```ts
const migration: Migration = {
  version: 31,
  name: 'physical_backbone_mapping',
  sql: `
    CREATE TABLE backbone_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      serial_number TEXT,
      asset_tag TEXT,
      ip_address TEXT,
      mac_address TEXT,
      island TEXT,
      zone TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','maintenance','retired')) DEFAULT 'active',
      provisional INTEGER NOT NULL CHECK(provisional IN (0,1)) DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_backbone_devices_serial_live
      ON backbone_devices(lower(serial_number))
      WHERE serial_number IS NOT NULL AND trim(serial_number) <> '' AND status <> 'retired';
    CREATE UNIQUE INDEX idx_backbone_devices_asset_live
      ON backbone_devices(lower(asset_tag))
      WHERE asset_tag IS NOT NULL AND trim(asset_tag) <> '' AND status <> 'retired';
    CREATE INDEX idx_backbone_devices_catalog_status
      ON backbone_devices(catalog_id, status);

    CREATE TABLE backbone_assignment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backbone_device_id INTEGER NOT NULL REFERENCES backbone_devices(id) ON DELETE RESTRICT,
      assignment_id INTEGER NOT NULL REFERENCES service_device_assignments(id) ON DELETE RESTRICT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      change_reason TEXT,
      created_by INTEGER REFERENCES users(id),
      ended_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(ended_at IS NULL OR ended_at >= started_at)
    );
    CREATE UNIQUE INDEX idx_backbone_assignment_links_one_active
      ON backbone_assignment_links(assignment_id) WHERE ended_at IS NULL;
    CREATE INDEX idx_backbone_assignment_links_backbone_active
      ON backbone_assignment_links(backbone_device_id, ended_at);
    CREATE INDEX idx_backbone_assignment_links_assignment_history
      ON backbone_assignment_links(assignment_id, started_at);

    WITH RECURSIVE units(catalog_id, label, ordinal, maximum) AS (
      SELECT id, trim(coalesce(brand || ' ', '') || model), 1, backbone_qty
      FROM equipment_catalog WHERE backbone_qty > 0
      UNION ALL
      SELECT catalog_id, label, ordinal + 1, maximum
      FROM units WHERE ordinal < maximum
    )
    INSERT INTO backbone_devices(catalog_id, name, provisional)
      SELECT catalog_id, label || ' #' || ordinal, 1 FROM units;

  `
};
```

Register `m0031` in order and add Drizzle declarations for the two new tables. Keep
the existing `backboneQty` schema field unchanged until Task 4.

- [ ] **Step 4: Add and run database constraint tests**

Add tests proving:

```ts
expect(() => insertSecondActiveLinkForSameAssignment()).toThrow();
expect(() => insertDuplicateLiveSerialIgnoringCase()).toThrow();
expect(() => insertDuplicateRetiredSerial()).not.toThrow();
```

Run:

```powershell
npx.cmd vitest run src/backend/db/migrate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the persistence foundation**

```powershell
git add src/backend/db/migrations/0031_physical_backbone_mapping.ts src/backend/db/migrations/index.ts src/backend/db/schema.ts src/backend/db/migrate.test.ts
git commit -m "feat(topology): persist physical backbone links"
```

---

### Task 2: Shared contracts and management repository

**Files:**
- Create: `src/shared/backbone.ts`
- Create: `src/backend/lib/backbone-management.ts`
- Create: `src/backend/lib/backbone-management.test.ts`

**Interfaces:**
- Produces:
  - `BackboneStatus = 'active' | 'maintenance' | 'retired'`
  - `BackboneDeviceSummary`
  - `BackboneDeviceDetail`
  - `BackboneAssignmentSummary`
  - `BackbonePage<T>`
  - `listBackbones(db, query)`
  - `getBackbone(db, id)`
  - `createBackbone(db, input, actorId)`
  - `updateBackbone(db, id, input, actorId)`
  - `listAssignments(db, query)`
  - `setAssignmentBackbone(db, assignmentId, input, actorId)`
  - `clearAssignmentBackbone(db, assignmentId, reason, actorId)`

- [ ] **Step 1: Define contracts and failing repository tests**

Define exact mutation inputs:

```ts
export type BackboneWriteInput = {
  catalogId: number;
  name: string;
  status: BackboneStatus;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  notes: string | null;
  expectedUpdatedAt?: string;
};

export type AssignmentBackboneInput = {
  backboneDeviceId: number;
  reason: string | null;
};
```

Write tests for normalization, pagination, unlinked filtering, create/update,
optimistic conflict, atomic transfer, unlink, and rejection of `retired` while active
links still exist.

- [ ] **Step 2: Run repository tests and observe failure**

```powershell
npx.cmd vitest run src/backend/lib/backbone-management.test.ts
```

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement read queries**

Use parameterized SQL and bounded pagination:

```ts
export type BackboneListQuery = {
  query?: string;
  status?: BackboneStatus;
  page: number;
  pageSize: number;
};

export type AssignmentListQuery = {
  query?: string;
  mapping: 'all' | 'linked' | 'unlinked';
  backboneDeviceId?: number;
  page: number;
  pageSize: number;
};
```

Search the normalized union of name/model/serial/asset/IP/MAC/island/zone for
backbones, and client code/name/service/IP/MAC/serial/asset/model for assignments.
Return total count and `{ page, pageSize, total, totalPages, items }`.

- [ ] **Step 4: Implement transactional mutations**

Normalize empty strings to null, uppercase MAC, trim identifiers, and throw typed
errors:

```ts
export class BackboneNotFoundError extends Error {}
export class BackboneConflictError extends Error {}
export class BackboneValidationError extends Error {}
```

`setAssignmentBackbone` must:

1. verify the assignment is active;
2. verify the target backbone is not retired;
3. end any current link;
4. insert the new link;
5. commit all changes atomically.

- [ ] **Step 5: Run repository tests**

```powershell
npx.cmd vitest run src/backend/lib/backbone-management.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit contracts and repository**

```powershell
git add src/shared/backbone.ts src/backend/lib/backbone-management.ts src/backend/lib/backbone-management.test.ts
git commit -m "feat(topology): add backbone management domain"
```

---

### Task 3: Authenticated management API and audit

**Files:**
- Create: `src/backend/routes/topology-management.ts`
- Create: `src/backend/routes/topology-management.test.ts`
- Modify: `src/backend/server.ts`
- Modify: `src/backend/routes/auth.test.ts`

**Interfaces:**
- Consumes all Task 2 repository functions and shared types.
- Produces the management routes documented in the design spec.

- [ ] **Step 1: Write failing HTTP and RBAC tests**

Cover:

```ts
expect((await asTechnician('POST', '/api/topology/backbones', validBody)).statusCode).toBe(403);
expect((await asOperator('POST', '/api/topology/backbones', validBody)).statusCode).toBe(201);
expect((await asTechnician('GET', '/api/topology/backbones')).statusCode).toBe(200);
expect((await request('PUT', `/api/topology/assignments/${assignmentId}/backbone`, {
  backboneDeviceId,
  reason: 'Transferência operacional'
})).statusCode).toBe(200);
```

Assert invalid IDs/input return `400`, missing records `404`, and stale update or
uniqueness conflict returns `409`.
Also assert creating a backbone leaves `equipment_catalog.stock_total` and
`stock_movements` unchanged.

- [ ] **Step 2: Run focused route tests and observe failure**

```powershell
npx.cmd vitest run src/backend/routes/topology-management.test.ts src/backend/routes/auth.test.ts
```

Expected: FAIL with missing routes.

- [ ] **Step 3: Implement schemas and routes**

Use:

```ts
const readOnly = { preHandler: requireAuth() };
const canManage = { preHandler: requireRole(['admin', 'operator']) };
const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);
```

Map repository errors to `400/404/409`. Return `201` for creation and `200` for
successful mutations.

- [ ] **Step 4: Record narrow audit events**

Write events named:

```ts
'topology.backbone.create'
'topology.backbone.update'
'topology.assignment.link'
'topology.assignment.transfer'
'topology.assignment.unlink'
```

Metadata contains only affected IDs, previous/next backbone IDs, and status
transitions. Assert audit rows in route tests.

- [ ] **Step 5: Register routes and run tests**

```powershell
npx.cmd vitest run src/backend/routes/topology-management.test.ts src/backend/routes/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the management API**

```powershell
git add src/backend/routes/topology-management.ts src/backend/routes/topology-management.test.ts src/backend/routes/auth.test.ts src/backend/server.ts
git commit -m "feat(topology): expose audited backbone management API"
```

---

### Task 4: Remove legacy quantity and preserve lifecycle/finance behavior

**Files:**
- Create: `src/backend/db/migrations/0032_retire_catalog_backbone_qty.ts`
- Modify: `src/backend/db/migrations/index.ts`
- Modify: `src/backend/db/schema.ts`
- Modify: `src/backend/db/migrate.test.ts`
- Modify: `src/backend/routes/stock.ts`
- Modify: `src/backend/routes/stock.test.ts`
- Modify: `src/backend/routes/investments.ts`
- Modify: `src/backend/routes/investments.test.ts`
- Modify: `src/backend/routes/technical.ts`
- Modify: `src/backend/routes/technical.test.ts`

**Interfaces:**
- Consumes `backbone_devices` and `backbone_assignment_links`.
- Produces no `backboneQty` stock field; ends active links with assignments.

- [ ] **Step 1: Write failing legacy-removal and finance tests**

Assert:

```ts
expect(stockSummary.rows[0]).not.toHaveProperty('backboneQty');
expect(savedCatalog).not.toHaveProperty('backbone_qty');
expect(investmentSummary.backboneStockCve).toBe(
  nonRetiredPhysicalBackboneCount * landedUnitCostCve
);
```

Add a service removal test that ends an assignment and expects its active topology
link to receive `ended_at`.
Add a migration-chain assertion that `backbone_qty` is absent only after migration
32 and that the physical rows created by migration 31 remain unchanged.

- [ ] **Step 2: Run focused tests and observe failure**

```powershell
npx.cmd vitest run src/backend/routes/stock.test.ts src/backend/routes/investments.test.ts
```

Expected: FAIL on legacy field/query and unclosed link.

- [ ] **Step 3: Add migration 32 and remove stock quantity handling**

Create immutable migration 32:

```ts
const migration: Migration = {
  version: 32,
  name: 'retire_catalog_backbone_qty',
  sql: `ALTER TABLE equipment_catalog DROP COLUMN backbone_qty;`
};
```

Register it after migration 31, remove `backboneQty` from the Drizzle schema, and
delete it from the catalog Zod schema, SELECT, INSERT, UPDATE, response, and test
fixtures. Do not add a replacement field to Stock.

- [ ] **Step 4: Replace the finance calculation**

Use a correlated count of non-retired physical devices:

```sql
SELECT COALESCE(SUM(
  (ec.purchase_price_cve + ec.shipping_cost_cve + ec.customs_duty_cve + ec.other_costs_cve)
  * bd.units
), 0)
FROM equipment_catalog ec
JOIN (
  SELECT catalog_id, COUNT(*) AS units
  FROM backbone_devices
  WHERE status <> 'retired'
  GROUP BY catalog_id
) bd ON bd.catalog_id = ec.id
```

- [ ] **Step 5: Close topology links when an assignment ends**

In the same transaction as assignment removal:

```sql
UPDATE backbone_assignment_links
SET ended_at = datetime('now'),
    ended_by = ?,
    change_reason = COALESCE(change_reason, 'assignment_closed'),
    updated_at = datetime('now')
WHERE assignment_id = ? AND ended_at IS NULL
```

- [ ] **Step 6: Run focused tests**

```powershell
npx.cmd vitest run src/backend/routes/stock.test.ts src/backend/routes/investments.test.ts src/backend/routes/technical.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit lifecycle and finance compatibility**

```powershell
git add src/backend/db/migrations/0032_retire_catalog_backbone_qty.ts src/backend/db/migrations/index.ts src/backend/db/schema.ts src/backend/db/migrate.test.ts src/backend/routes/stock.ts src/backend/routes/stock.test.ts src/backend/routes/investments.ts src/backend/routes/investments.test.ts src/backend/routes/technical.ts src/backend/routes/technical.test.ts
git commit -m "refactor(topology): retire catalog backbone quantities"
```

Before committing, verify `git diff --cached --name-only` includes no unrelated route
files.

---

### Task 5: Convert the topology read model to explicit links

**Files:**
- Modify: `src/shared/topology.ts`
- Modify: `src/backend/lib/topology-read-model.ts`
- Modify: `src/backend/lib/topology-search.ts`
- Modify: `src/backend/routes/topology.test.ts`

**Interfaces:**
- Produces `TopologyRelationship = 'defined_link'`.
- `TopologyBackboneNode` includes `backboneDeviceId`, identity/location fields,
  `provisional`, and no `backboneQty`.
- Branch route parameter is `backbone_devices.id`.

- [ ] **Step 1: Rewrite fixtures/tests to express physical links**

Seed two physical backbones, link only selected assignments, and assert:

```ts
expect(snapshot.backbones[0]).toMatchObject({
  id: `backbone:${backboneDeviceId}`,
  backboneDeviceId,
  catalogId,
  relationship: 'defined_link'
});
expect(branch.nodes.map((node) => node.assignmentId)).toEqual([linkedAssignmentId]);
expect(snapshot.stats.unmappedAssignmentCount).toBe(1);
```

Search for an unlinked assignment must return it with only the logical root ancestor.

- [ ] **Step 2: Run topology route tests and observe failure**

```powershell
npx.cmd vitest run src/backend/routes/topology.test.ts
```

Expected: FAIL because the read model still uses `backbone_qty/catalog_id`.

- [ ] **Step 3: Update shared topology contracts**

Use:

```ts
export type TopologyRelationship = 'defined_link';

export type TopologyBackboneNode = {
  id: `backbone:${number}`;
  kind: 'backbone';
  backboneDeviceId: number;
  catalogId: number;
  label: string;
  brand: string | null;
  model: string;
  catalogType: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  provisional: boolean;
  administrativeState: TopologyAdministrativeState;
  issueCodes: TopologyIssueCode[];
  parentId: 'root:isp';
  relationship: 'defined_link';
};
```

Add `provisional_identity` to `TopologyIssueCode`.

- [ ] **Step 4: Rewrite snapshot, branch, stats, and search queries**

Snapshot loads non-retired `backbone_devices`. Branch joins active
`backbone_assignment_links` to active assignments. Stats count active assignments
with/without active links. Search ancestors follow the active link, never `catalog_id`.

- [ ] **Step 5: Run backend topology tests**

```powershell
npx.cmd vitest run src/backend/routes/topology.test.ts src/backend/routes/topology-management.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the factual read model**

```powershell
git add src/shared/topology.ts src/backend/lib/topology-read-model.ts src/backend/lib/topology-search.ts src/backend/routes/topology.test.ts
git commit -m "refactor(topology): render explicit backbone links"
```

---

### Task 6: Renderer management API and state hook

**Files:**
- Create: `src/renderer/modules/topology/backbone-api.ts`
- Create: `src/renderer/modules/topology/backbone-api.test.ts`
- Create: `src/renderer/modules/topology/useBackboneWorkspace.ts`
- Create: `src/renderer/modules/topology/useBackboneWorkspace.test.tsx`

**Interfaces:**
- Consumes management contracts from `src/shared/backbone.ts`.
- Produces `createBackboneApi(fetcher)` and `useBackboneWorkspace(api, onMutation)`.

- [ ] **Step 1: Write failing API serialization tests**

Assert exact URLs:

```ts
expect(calls[0]).toBe(
  'http://127.0.0.1:3001/api/topology/backbones?page=1&pageSize=25&status=active&q=rocket'
);
expect(calls[1]).toBe(
  'http://127.0.0.1:3001/api/topology/assignments?page=1&pageSize=25&mapping=unlinked&q=cliente'
);
```

Assert mutation methods pass JSON headers/body and surface API error messages.

- [ ] **Step 2: Run API tests and observe failure**

```powershell
npx.cmd vitest run src/renderer/modules/topology/backbone-api.test.ts
```

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the typed API client**

Use `authFetch`, `URLSearchParams`, and one response parser that throws:

```ts
export class BackboneApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
```

- [ ] **Step 4: Write failing hook tests**

Cover initial list, selected detail, debounced search, mutation refresh,
conflict-preserved dialog state, and `onMutation()` called exactly once after success.

- [ ] **Step 5: Implement the workspace hook**

Return a stable object containing:

```ts
{
  backbones, selectedId, selected, assignments, unlinked,
  query, statusFilter, loading, error, mutationState,
  setQuery, setStatusFilter, selectBackbone, refresh,
  createBackbone, updateBackbone, linkAssignments,
  transferAssignment, unlinkAssignment
}
```

Use request cancellation/stale-response guards for search and keep page/filter state
separate for backbones and assignments. `linkAssignments(assignmentIds,
backboneDeviceId)` performs the selected calls in a bounded sequence, refreshes once
after all settle, retains failed selections with their server messages, and invokes
`onMutation` once when at least one link succeeds.

- [ ] **Step 6: Run hook/client tests and commit**

```powershell
npx.cmd vitest run src/renderer/modules/topology/backbone-api.test.ts src/renderer/modules/topology/useBackboneWorkspace.test.tsx
git add src/renderer/modules/topology/backbone-api.ts src/renderer/modules/topology/backbone-api.test.ts src/renderer/modules/topology/useBackboneWorkspace.ts src/renderer/modules/topology/useBackboneWorkspace.test.tsx
git commit -m "feat(topology): add backbone management client state"
```

Expected: PASS, then commit succeeds.

---

### Task 7: Backbone management workspace

**Files:**
- Create: `src/renderer/modules/topology/BackboneWorkspace.tsx`
- Create: `src/renderer/modules/topology/BackboneList.tsx`
- Create: `src/renderer/modules/topology/BackboneDetail.tsx`
- Create: `src/renderer/modules/topology/BackboneDialogs.tsx`
- Create: `src/renderer/modules/topology/BackboneWorkspace.css`
- Create: `src/renderer/modules/topology/BackboneWorkspace.test.tsx`

**Interfaces:**
- Consumes `useBackboneWorkspace`, `useAuth`, and design-system primitives.
- Produces:

```ts
export type BackboneWorkspaceProps = {
  onMutation: () => void;
  onViewTopology: (backboneDeviceId: number) => void;
};
```

- [ ] **Step 1: Write failing accessibility and permission tests**

Assert:

```ts
expect(screen.getByRole('heading', { name: 'Backbone' })).toBeTruthy();
expect(screen.getByRole('button', { name: 'Novo backbone' })).toBeTruthy();
expect(screen.getByText('Sem ligação')).toBeTruthy();
```

For technician, assert mutation buttons are absent but list/detail remain visible.
Test keyboard selection and focus restoration after dialogs.

- [ ] **Step 2: Run component tests and observe failure**

```powershell
npx.cmd vitest run src/renderer/modules/topology/BackboneWorkspace.test.tsx
```

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement list and responsive master/detail shell**

Use semantic buttons for selectable rows, server pagination, status filter, counts,
and explicit loading/error/empty states. Desktop uses two columns; below `760px`,
selected detail becomes the second navigation level with a Back button.

- [ ] **Step 4: Implement detail and data-quality presentation**

Show identity fields, linked equipment, client/service metadata, provisional badge,
and **Ver na Topologia**. Missing identity fields use factual “Não informado” copy,
never fabricated values.

- [ ] **Step 5: Implement dialogs and mutations**

Create/edit fields match `BackboneWriteInput`. Link/transfer dialog searches unlinked
or all active assignments and supports one or multiple selections. Unlink requires
confirmation. On `409`, keep failed selections in the dialog, display their server
messages, and refresh affected data.

- [ ] **Step 6: Implement CSS and responsive/accessibility tests**

Use existing tokens, dark-first visual language, visible focus, reduced motion, and
no color-only states. Verify `role="dialog"`, labels, focus return, and mobile detail
navigation.

- [ ] **Step 7: Run workspace tests and commit**

```powershell
npx.cmd vitest run src/renderer/modules/topology/BackboneWorkspace.test.tsx
git add src/renderer/modules/topology/BackboneWorkspace.tsx src/renderer/modules/topology/BackboneList.tsx src/renderer/modules/topology/BackboneDetail.tsx src/renderer/modules/topology/BackboneDialogs.tsx src/renderer/modules/topology/BackboneWorkspace.css src/renderer/modules/topology/BackboneWorkspace.test.tsx
git commit -m "feat(topology): add backbone mapping workspace"
```

Expected: PASS. Check the staged list before commit so pre-existing map tests are not
accidentally included.

---

### Task 8: Tab shell, invalidation, and cross-tab focus

**Files:**
- Create: `src/renderer/modules/topology/TopologyMapView.tsx`
- Modify: `src/renderer/modules/topology/TopologyModule.tsx`
- Modify: `src/renderer/modules/topology/TopologyModule.css`
- Modify: `src/renderer/modules/topology/TopologyModule.test.tsx`
- Modify: `src/renderer/App.topology.test.tsx`

**Interfaces:**
- Consumes `BackboneWorkspace`.
- Produces default tab `backbone`; map receives `revision` and optional
  `focusBackboneDeviceId`.

- [ ] **Step 1: Write failing tab/invalidation tests**

Assert:

```ts
expect(screen.getByRole('tab', { name: 'Backbone' }).getAttribute('aria-selected'))
  .toBe('true');
expect(screen.getByRole('tab', { name: 'Topologia' }).getAttribute('aria-selected'))
  .toBe('false');
```

Simulate a successful link, switch to Topologia, and assert a fresh
`GET /api/topology`. Trigger **Ver na Topologia** and assert the physical backbone is
selected/focused after the map loads.

- [ ] **Step 2: Run integration tests and observe failure**

```powershell
npx.cmd vitest run src/renderer/modules/topology/TopologyModule.test.tsx src/renderer/App.topology.test.tsx
```

Expected: FAIL because the current module renders the map directly.

- [ ] **Step 3: Extract the existing map without behavior changes**

Move the current map workspace, toolbar, cache, loading, inspector, and canvas
behavior into:

```ts
export type TopologyMapViewProps = TopologyModuleProps & {
  revision: number;
  focusBackboneDeviceId: number | null;
  onFocusHandled: () => void;
};
```

Key its workspace/cache by `revision` so every successful management mutation clears
snapshot, branch cache, search results, selection, and stale focus.

- [ ] **Step 4: Implement accessible tabs**

`TopologyModule` owns:

```ts
const [activeTab, setActiveTab] = useState<'backbone' | 'topology'>('backbone');
const [revision, setRevision] = useState(0);
const [focusBackboneDeviceId, setFocusBackboneDeviceId] = useState<number | null>(null);
```

Arrow Left/Right changes tab and focus. `onViewTopology(id)` sets focus, switches tab,
and lets the map clear focus after centering.

- [ ] **Step 5: Run integration tests and commit**

```powershell
npx.cmd vitest run src/renderer/modules/topology/TopologyModule.test.tsx src/renderer/App.topology.test.tsx
git add src/renderer/modules/topology/TopologyMapView.tsx src/renderer/modules/topology/TopologyModule.tsx src/renderer/modules/topology/TopologyModule.css src/renderer/modules/topology/TopologyModule.test.tsx src/renderer/App.topology.test.tsx
git commit -m "feat(topology): compose backbone and topology tabs"
```

Expected: PASS.

---

### Task 9: Update map presentation and remove Stock UI

**Files:**
- Modify: `src/renderer/modules/topology/TopologyNodes.tsx`
- Modify: `src/renderer/modules/topology/TopologyInspector.tsx`
- Modify: `src/renderer/modules/topology/TopologyToolbar.tsx`
- Modify: `src/renderer/modules/topology/topology-graph.ts`
- Modify: topology fixtures/tests/CSS
- Modify: `src/renderer/modules/StockModule.tsx`
- Modify: `src/renderer/types.ts`
- Modify: Stock/App tests that construct `StockCatalogRow`

**Interfaces:**
- Consumes physical `TopologyBackboneNode`.
- Produces no renderer use of `backboneQty` or `inventory_lineage`.

- [ ] **Step 1: Update failing map/Stock tests**

Assert physical metadata appears in the inspector and edge labels use:

```ts
expect(screen.getByText('ligação definida')).toBeTruthy();
expect(screen.getByText('10.20.0.1')).toBeTruthy();
expect(screen.queryByLabelText('Unidades backbone')).toBeNull();
expect(screen.queryByRole('columnheader', { name: 'Backbone' })).toBeNull();
```

- [ ] **Step 2: Run focused tests and observe failure**

```powershell
npx.cmd vitest run src/renderer/modules/topology src/renderer/App.topology.test.tsx
```

Expected: FAIL on legacy copy/fields.

- [ ] **Step 3: Update nodes, inspector, legend, and search copy**

Backbone node metadata prioritizes name, model, IP/location and CPE count. Inspector
shows serial/asset/IP/MAC/location and provisional attention. Replace every
user-visible “inventário” relationship label with “ligação definida”; retain
“inventário” only where describing stock/catalog provenance.

- [ ] **Step 4: Remove Stock backbone controls**

Delete `backboneQty` form state, payload, filter, sort key, badge, column and field.
Keep `focusCatalogId` navigation intact because the Topologia inspector still links
to the underlying catalog model.

- [ ] **Step 5: Run renderer tests and commit**

```powershell
npx.cmd vitest run src/renderer/modules/topology src/renderer/App.topology.test.tsx
npm.cmd run lint
npm.cmd run typecheck
git add src/renderer/modules/topology src/renderer/modules/StockModule.tsx src/renderer/types.ts src/renderer/App.topology.test.tsx
git commit -m "refactor(topology): present physical backbone relationships"
```

Expected: tests, lint, and typecheck pass.

---

### Task 10: ADR, full verification, and visual QA

**Files:**
- Create: `docs/adr/0005-explicit-physical-backbone-links.md`
- Modify: `docs/adr/0004-topology-inventory-lineage-read-model.md`
- Modify: `reviews/topology-review.md`
- Modify only defect-related files discovered during verification

**Interfaces:**
- Consumes the complete implementation.
- Produces final architecture record and verification evidence.

- [ ] **Step 1: Write ADR 0005 and supersede ADR 0004**

ADR 0005 records:

- physical backbone identity;
- temporal one-active-link invariant;
- provisional migration;
- explicit `defined_link` semantics;
- no telemetry/reachability claim;
- lazy snapshot/branch loading;
- Stock and finance consequences.

ADR 0004 status becomes `Superseded by ADR 0005`.

- [ ] **Step 2: Run the complete automated verification**

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npx.cmd vite build --manifest
```

Expected: all tests pass, no lint/type errors, backend/main compile succeeds, and the
production manifest retains a separate lazy Topology chunk.

- [ ] **Step 3: Run migration compatibility checks**

Run the migration test suite against an old schema fixture and assert:

```sql
PRAGMA foreign_key_check;
```

returns no rows. Confirm the number of non-retired migrated backbones equals the sum
of legacy positive `backbone_qty` values.

- [ ] **Step 4: Perform desktop, tablet, and mobile visual QA**

With the existing dev server:

```powershell
npm.cmd run dev
```

Verify at approximately `1440×900`, `1024×768`, and `390×844`:

- Backbone is first/default;
- create/edit/link/transfer/unlink flows;
- technician read-only state;
- provisional and unlinked attention states;
- keyboard tabs/dialogs/focus return;
- immediate map refresh and focused “Ver na Topologia” transition;
- no overlap in React Flow;
- inspector/bottom sheet;
- console and network panel contain no errors.

- [ ] **Step 5: Record review evidence and fix defects with focused tests**

Append a final review round to `reviews/topology-review.md` with exact command results,
visual viewport results, remaining limitations, and zero unresolved Critical/High/
Medium findings. If a defect appears, stop this task, return to the task that owns the
affected file, add a reproducing test, make the smallest fix, rerun its focused and
affected suite, and commit that fix before resuming this step.

- [ ] **Step 6: Commit documentation and verified fixes**

```powershell
git add docs/adr/0004-topology-inventory-lineage-read-model.md docs/adr/0005-explicit-physical-backbone-links.md reviews/topology-review.md
git diff --cached --check
git commit -m "docs(topology): record explicit backbone architecture"
```

Expected: final `git status --short` is clean except for unrelated user-owned files,
and every verification result recorded in the review is reproducible.

---

## Code Review Round 1 — 2026-07-28

**Scope**: Backend contracts, topology read model, authenticated routes, and tests
**Build Status**: PASS (`39` focused tests; renderer/global typecheck)

### Issues

#### Issue 1 (High): Public node contract diverges from the approved discriminated union
**File**: `src/shared/topology.ts:25`

The approved contract requires `TopologyNode` to discriminate `logical-root`, `backbone`, and `client-device`. The implementation instead exposes separate types with `kind: 'root' | 'backbone' | 'assignment'` and does not export the required `TopologyNode` union. This makes the API and future graph composition incompatible with the plan.

**Fix**: Export the exact `TopologyNode` discriminated union, rename the logical root and physical CPE kinds to `logical-root` and `client-device`, and keep stable IDs `root:isp`, `backbone:<id>`, and `assignment:<id>`.

#### Issue 2 (High): Edge contract and initial connections are missing
**File**: `src/shared/topology.ts:65`

No `TopologyEdge` type exists, and neither response exposes `core-link` nor `client-link` edges. The frontend cannot build a deterministic hierarchy without reconstructing undocumented relationships.

**Fix**: Add a typed `TopologyEdge` union with stable edge IDs and `core-link | client-link`, return initial root-to-backbone edges from `GET /api/topology`, and return backbone-to-CPE edges from the branch endpoint.

#### Issue 3 (High): Initial endpoint defeats branch lazy loading
**File**: `src/backend/lib/topology-read-model.ts:228`

`GET /api/topology` currently loads and serializes every active assignment and all client/service associations. The approved behavior requires the initial response to contain the logical root, backbones, initial connections, and factual aggregate stats only; CPEs must be fetched per expanded backbone. This implementation scales with the full device population and puts React Flow data into the initial request.

**Fix**: Make the initial snapshot return only root + backbone nodes and core edges. Compute global stats with aggregate read-only queries without returning CPE payloads. Keep assignments out of the initial response.

#### Issue 4 (High): Branch endpoint does not return physical CPE nodes
**File**: `src/backend/lib/topology-read-model.ts:273`

`GET /api/topology/backbones/:id/clients` returns merged clients but omits the physical assignment nodes entirely. The plan explicitly requires CPEs physical plus their connections, with one node per assignment and every associated client/service listed on that node.

**Fix**: Return branch `nodes: TopologyClientDeviceNode[]` and `edges: TopologyEdge[]`, retaining clients/services inside each deduplicated assignment node. Include branch stats and backbone metadata as useful context.

#### Issue 5 (Medium): Tests encode the wrong eager response
**File**: `src/backend/routes/topology.test.ts:182`

Tests assert that `/api/topology` returns three assignments and that the branch response contains only merged clients. They therefore protect behavior contrary to the approved plan.

**Fix**: Rewrite the affected tests to assert no CPE payload in the initial response, correct node kinds, typed edges, physical-device deduplication in the branch response, and owner/share associations on that single node.

### Verdict: NEEDS_FIX

---

## Code Review Round 2 — 2026-07-28

**Scope**: Verification of all Round 1 backend fixes
**Build Status**: PASS (`40` focused tests; `566` full-suite tests reported; global and main TypeScript checks)

### Resolution

- The public `TopologyNode` union now uses `logical-root`, `backbone`, and `client-device`.
- `TopologyEdge` now exposes deterministic `core-link` and `client-link` variants.
- `GET /api/topology` contains only the logical root, backbones, core edges, aggregate stats, and timestamp.
- Assignment and association reads are absent from the initial payload path and isolated to branch/search reads.
- The branch endpoint returns one physical node per active assignment, all owner/share associations, client edges, and factual branch stats.
- Tests now reject eager CPE payloads and cover exact node/edge contracts.

### Issues

No Critical, High, or Medium issues remain in the reviewed backend scope.

### Verdict: APPROVED

---

## Code Review Round 3 — 2026-07-28

**Scope**: Renderer API, session cache, graph composition, factual filters, and Dagre layout
**Build Status**: PASS (`16` focused tests; `582` full-suite tests reported; lint and TypeScript checks)

### Resolution

- Branch cache deduplicates concurrent requests, evicts failed in-flight work, and isolates retries.
- Graph composition renders only expanded loaded branches and deduplicates by stable public IDs.
- Filters retain every visible ancestor and edge required for context.
- Dagre layout is deterministic and enforces left-to-right root/backbone/CPE columns.
- React Flow is type-only outside the layout boundary; no eager application module imports the graph packages.

### Issues

No Critical, High, or Medium issues remain in the reviewed frontend foundation scope.

### Verdict: APPROVED

---

## Code Review Round 4 — 2026-07-28

**Scope**: Integrated renderer, cross-module navigation, factual lineage gaps,
responsive behavior, browser interaction, dependency impact, and final verification

**Build Status**: PASS (`65` focused tests; `601` full-suite tests in `65` files;
lint; renderer and main TypeScript checks; Vite production build with manifest)

### Resolution

- Backbone search results now load and expand their branch through the session cache.
- The synthesized root is consistently labelled `Internet / Core ISPM`.
- Service actions carry the exact `serviceId` into `ServicesModule`; clients with
  multiple services open the requested service rather than only filtering the list.
- Snapshot stats distinguish total, mapped, and unmapped physical assignments.
  Search and inspector views mark CPEs whose catalog has no factual backbone lineage.
- ADR 0004 records the synthesized root, inventory-lineage semantics, absence of
  reachability/telemetry, catalog-level backbone limits, lazy loading, cache, and
  chunking decisions.
- Browser validation exposed all same-kind Dagre nodes sharing one mutable size
  object, causing every backbone to overlap. Each Dagre node now receives an
  independent size object, and the layout test rejects equal vertical positions for
  sibling backbones.
- Selecting a search result clears the search popover. The minimap is desktop-only;
  tablet and mobile layouts retain canvas controls without horizontal overflow.
- Desktop (`1440×900`), tablet (`820×1000`), and mobile (`390×844`) browser runs
  verified lazy branch loading, isolated retry, keyboard inspector behavior,
  unmapped-CPE inspection, exact service navigation, and responsive inspector modes.
  No page errors occurred; the only console error was the intentionally injected
  `503` used to verify retry recovery.
- Production manifest keeps `TopologyModule` as a dynamic entry
  (`247.25 kB`, `81.43 kB` gzip). The existing initial chunk warning remains
  (`606.47 kB`).
- `npm audit` still reports `31` advisories in the existing dependency graph
  (`1` low, `5` moderate, `21` high, `4` critical). None of the `22` packages added
  for Dagre/React Flow appears in the vulnerable set; no automatic fixes were applied.

### Issues

No Critical, High, or Medium issues remain in the reviewed Topology scope.

### Verdict: APPROVED

---

## Code Review Round 5 — 2026-07-30

**Scope**: Physical backbone mapping — outstanding red tests, migration
compatibility against the real field database, and the first browser pass over
the two-tab module

**Build Status**: PASS (`683` tests in `72` files; lint; renderer and main
TypeScript checks; Vite production build with manifest)

### Resolution

- Three tests were left failing and uncommitted at the end of the previous
  session. Two named real defects and one was mis-structured:
  - The focus effect depended on the whole `useTopologyWorkspace` object, whose
    identity changes on every render. Every render cancelled and rescheduled the
    animation frame, so `centerNode` never ran and “Ver na Topologia” landed on
    the map without centring the requested unit. The effect now depends only on
    `pendingFocusId`, a `focusable` boolean, and stable setters.
  - The map's `Escape` listener stayed active while the panel was merely
    `hidden`, so pressing Escape on the Backbone tab cleared the map selection.
    The listener is now bound only while the Topologia tab is active.
  - A retired backbone offered “Ver na Topologia” even though the read model
    filters `status <> 'retired'`. The detail now states
    “Retirado — não aparece na topologia ativa” in a `role="status"` note.
  - The two module tests asserted inside the same `act()` scope that triggered
    the work, so React had not flushed the effects yet. Split into two scopes.
- Migration compatibility, run against a copy of the real field database,
  exposed a blocking conflict: an abandoned development build had applied a
  different migration `31` (`backbone_devices` + `backbone_client_links`) on that
  machine, and the operator had already recorded six real units and twenty-four
  links through it. Shipping this chain as `31`/`32` would have aborted the boot
  with checksum drift, and dropping the tables would have destroyed real data.
  The chain now starts at `33` and adopts the legacy rows — names, IPs and links
  kept, `active` mapped to `status`, `provisional = 0` — generating provisional
  units only for the catalogued quantity the adopted rows do not account for.
- Verified on the copy: `6` devices adopted, `24` links open, no legacy tables
  left, `backbone_qty` dropped, `PRAGMA foreign_key_check` and
  `PRAGMA integrity_check` clean.
- Browser QA found the backbone workspace rendering as an empty box: the
  workspace declared `grid-template-rows: auto auto minmax(34rem, 1fr)` while its
  inline error banner is conditional, so with no error the master/detail pane
  landed in the content-sized second row and collapsed to `35px` while the
  reserved `544px` row stayed empty. jsdom has no layout, so no test could see
  it. The workspace is now a flex column and the pane grows with `flex: 1`.
- Browser pass at `1920×911` with the real data: Backbone opens first, the six
  adopted units list with their IPs and link counts, the detail shows identity
  and deployment, “Ver na Topologia” switches tabs and focuses the unit, branch
  expansion loads CPEs with their attention states, Escape from Backbone
  preserves the map selection, and Escape on the map closes the inspector. No
  console errors.
- Container-query widths of `760px` and `390px` were exercised by narrowing the
  module container: master/detail collapses to one pane with a working “Voltar”,
  list tools stack, and nothing overflows horizontally.

### Issues

No Critical, High, or Medium issues remain in the reviewed Topology scope.

### Limitations

- The browser pass ran against the Vite dev server with a copy of the field
  database, not the packaged Electron shell, and the host window could not be
  resized below `1920px`, so the `1024×768` and `390×844` viewport checks were
  approximated through the module's container queries. A packaged smoke test at
  real viewport sizes is still owed.
- Technician read-only state was verified by the route and workspace tests, not
  in the browser.

### Verdict: APPROVED

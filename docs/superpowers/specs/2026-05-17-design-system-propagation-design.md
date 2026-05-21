# Design System Propagation

**Date:** 2026-05-17
**Status:** Approved (design)
**Project:** ISPM — desktop ISP manager (Electron + React + Fastify + SQLite), Cabo Verde

> This is the **second pass of the design-system roadmap**. The first pass
> (the dark-first editorial rewrite) is referred to below as "the dark-first
> overhaul". Internal phases of *this* spec are numbered **Delivery 1..7** to
> avoid collision with that roadmap numbering.

## Context

The dark-first overhaul rewrote the ISPM renderer into a dark-first, editorial design system
(`src/renderer/styles.css`: OKLCH warm-neutral tokens hue ~72, Fraunces + Plus
Jakarta Sans, two token layers + legacy aliases). Only **shell + Dashboard +
PaymentsModule** received bespoke polish and became the visual source of truth.
The other six modules (Clientes, Planos, Serviços, Stock, Relatórios,
Definições) render coherently *only* because the legacy aliases
(`--ink/--panel/--line/--paper/--muted/--green/--red/--blue/--gold`) map old
class usage onto new tokens. Their markup is still generic and unrefined.

The renderer is effectively a single file: `src/renderer/App.tsx` (~2210 lines)
holds the shell, navigation, all nine module functions, and shared helpers.
Supporting files: `src/renderer/main.tsx`, `src/renderer/lib/format.ts`,
`src/renderer/styles.css`. **The project is not under git** — there is no
rollback net, which constrains the rollout strategy.

## Goal

Bring the six unrefined modules to full **bespoke parity** with the polished
slice, by extracting a **shared primitive layer** and **splitting each module
into its own file**. This is a structural + visual delivery only:

- No new features.
- No behavior changes.
- No backend changes.
- No domain-language changes (terminology stays exactly per `CONTEXT.md`).
- No new runtime dependencies.

Success = the six modules are visually indistinguishable in quality from
Dashboard/Pagamentos, App.tsx is reduced to shell + router, and every delivery
passes the validation gate with the polished slice unchanged.

## Non-Goals (YAGNI)

- No routing library — navigation stays state-driven in App.tsx.
- No CSS-in-JS, no Tailwind, no Storybook, no design-token build tooling.
- No new npm dependencies.
- No customer-detail screen, no robust-PDF work — those remain separate future
  deliveries from `PLAN.md` and must not be folded in here.
- No test-framework or backend-route changes.

## Architecture

### Target file structure

```
src/renderer/
  App.tsx              shell + sidebar nav + section router only (~250 lines)
  types.ts             shared cross-module types lifted out of App.tsx
  components/          primitive + composed-pattern layer (one file per unit)
  modules/
    Dashboard.tsx
    PaymentsModule.tsx
    ClientsModule.tsx
    PlansModule.tsx
    ServicesModule.tsx
    StockModule.tsx
    ReportsModule.tsx
    SettingsModule.tsx
  lib/format.ts        unchanged
  main.tsx             unchanged (font imports stay before styles.css)
  styles.css           tokens unchanged; component CSS co-located via the
                       existing plain-class system (no new mechanism)
```

Module-private types stay co-located in their module file. Only types shared
across modules/components move to `src/renderer/types.ts`. The section router
in App.tsx keeps the existing `SectionId` union and the
`{section === '...' && <XModule />}` switching pattern — it is not replaced,
only relocated and trimmed.

### Primitive layer (hybrid: thin primitives + a few composed patterns)

Extracted from the **real markup of the polished slice**, not invented. Each
unit is its own file in `components/`, with typed props and no
module-specific logic.

**Thin primitives**

| Component | Responsibility |
|-----------|----------------|
| `Card` | Surface container (panel) with optional header. |
| `Badge` | Status pill. Tones: `success \| danger \| info \| neutral \| accent`. |
| `Button` | Variants: `primary` (accent bg), `ghost`, `icon`. |
| `Field` | Label + input + error message wrapper. |
| `Select` | Styled select consistent with `Field`. |
| `Toolbar` | Horizontal action/filter container. |
| `EmptyState` | Empty/zero-data placeholder with optional action. |
| `Message` | Inline module-level error/success (`module-message` pattern). |
| `MetricCard` + `MetricGrid` | Dashboard indicator card and its grid. |
| `PageHeader` | Eyebrow + title + right-aligned actions (topbar context). |

**Composed patterns (the hybrid layer — only where the slice already repeats them)**

| Component | Responsibility |
|-----------|----------------|
| `FilterBar` | Text search + one or more select filters. Already the de-facto pattern in Pagamentos and Stock. |
| `DataList` | Compact row list with status badge + icon quick-actions. Pagamentos' list pattern. |
| `DetailModal` | Overlay for entity detail/preview — the shared `selected*` pattern used by Services, Payments, Stock, Clients. |

Modules remain free to break a composed pattern and compose thin primitives
directly when the editorial layout demands it. Composed patterns are
conveniences, not mandates — this is what keeps six bespoke modules coherent
without becoming template-y (the design-system memo explicitly fails uniform
template sameness).

Naming and visual behavior must match the polished slice's existing class
vocabulary (`app-shell, sidebar, brand, brand-mark, nav-list, content, topbar,
eyebrow, status, theme-toggle, metric-grid, metric-card, module-message`) so
extraction is a faithful refactor, not a re-design.

## Delivery Plan

Deliveries are sequential. Each ends at a validation gate and a user review
checkpoint before the next begins. One module per delivery (after the
foundation) — granularity is the safety mechanism given no git.

### Delivery 1 — Foundation (keystone, highest risk)

1. Create `components/` and extract every primitive + composed pattern listed
   above from the polished slice's current markup.
2. Refactor **shell + Dashboard + PaymentsModule** to consume the primitives.
3. Move Dashboard and PaymentsModule into `modules/`, set the App.tsx →
   shell+router shape, and lift shared types into `types.ts`.

**Zero-regression contract:** after Delivery 1 the polished slice must be
pixel-identical to before. The polished slice is the oracle that proves the
primitives faithfully captured the source of truth. Any visual delta in
Dashboard/Pagamentos is a defect in the extraction, not an accepted change.

### Deliveries 2–7 — One module per delivery, in this order

Ordered by centrality/risk so the hardest validation of the primitive layer
happens first:

- **Delivery 2 — Clientes** — richest module (filters, detail, WhatsApp
  action); hardest test of the primitives.
- **Delivery 3 — Planos**
- **Delivery 4 — Serviços**
- **Delivery 5 — Stock**
- **Delivery 6 — Relatórios**
- **Delivery 7 — Definições** — contains the already-shipped, code-review-approved
   `BackupsPanel`. Re-skin its presentation only; **do not alter backup/restore
   logic, IPC, or the `db.backup()` / `journal_mode = DELETE` normalization**.

Each module delivery: move the module to its own file, rebuild its markup
bespoke on the primitive layer, pass the validation gate, then stop for user
review before the next module.

## Validation & Safety

The project has no git history, so the safety model is: a filesystem snapshot
plus a green automated gate at every delivery boundary.

- **Before Delivery 1:** create `ispm-pre-designprop-20260517.zip` of
  `src/` at the project root as the rollback net.
- **Per-delivery automated gate (all must be green):**
  - `npm.cmd run typecheck`
  - `npm.cmd test`
  - `npx.cmd tsc -p tsconfig.main.json`
  - Delivery 1 additionally: production `vite build` (proves the offline font
    bundle and module split build cleanly).
  - `.cmd` suffixes are required — the environment is PowerShell on Windows and
    the validation hooks depend on it.
- **Manual Electron GUI smoke** (`npm.cmd run dev`) is the user's
  responsibility and is flagged at the end of each delivery. Claude cannot
  drive the Electron GUI.

## Known Environment Constraint (not a bug to fix)

`npm.cmd run build` reaches `electron-builder` but fails on this machine when
rebuilding `better-sqlite3` because Visual Studio Build Tools for `node-gyp`
are absent. This is an environment dependency, out of scope here, and must not
be "fixed" as part of this work. Production verification for this delivery uses
`vite build` only.

## Risks

| Risk | Mitigation |
|------|------------|
| No git rollback. | Pre-work zip snapshot + one-module-at-a-time gates. |
| Delivery 1 is a broad refactor touching the working polished slice. | Zero-regression contract with the polished slice as visual oracle; automated gate before review. |
| Six bespoke modules drift into inconsistency. | Hybrid primitive layer enforces shared tokens/interaction; composed patterns capture the repeated structures. |
| Definições delivery disturbs shipped backup/restore. | Presentation-only re-skin; explicit prohibition on touching backup logic/IPC/normalization. |
| App.tsx split introduces import/type regressions. | `tsc -p tsconfig.main.json` + `npm.cmd run typecheck` in every gate. |

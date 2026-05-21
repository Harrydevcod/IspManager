# Design System Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the six unrefined ISPM modules (Clientes, Planos, Serviços, Stock, Relatórios, Definições) to full bespoke parity with the polished slice by extracting a shared primitive layer and splitting each module into its own file.

**Architecture:** Extract presentational primitives + a few composed patterns from the current polished slice (shell + Dashboard + PaymentsModule) into `src/renderer/components/`. Split each module out of the 2210-line `App.tsx` into `src/renderer/modules/`. App.tsx shrinks to shell + nav + section router. No new features, no behavior changes, no new dependencies.

**Tech Stack:** React 19 + TypeScript + Vite 7 (renderer), plain-class CSS via existing `src/renderer/styles.css` OKLCH token system. No CSS-in-JS, no routing lib, no Storybook, no test-runner additions.

---

## Execution Conventions (read before Task 1 — these replace plan-template defaults)

**ISPM is NOT a git repository.** Ignore every "git add / git commit" reflex. The safety model defined by the approved spec is:

- **Filesystem snapshots, not commits.** A pre-work `.zip` of `src/` is taken before Delivery 1 (Task 1). An incremental `.zip` is taken at the end of every Delivery (the per-delivery checkpoint). These zips ARE the rollback net.
- **The validation gate ends every task**, in place of a commit. The gate is, run from the project root `C:\Users\Arydson\Downloads\ispm`:

  ```powershell
  npm.cmd run typecheck
  npx.cmd tsc -p tsconfig.main.json
  npm.cmd test
  ```

  Expected: all three exit 0. `npm.cmd test` is the backend Vitest suite — it must stay green (these renderer changes must not break it). `.cmd` suffixes are mandatory (PowerShell on Windows; validation hooks depend on it).

- **No renderer unit tests are added.** The spec forbids new dependencies and test-framework changes, and the renderer has no component-test infrastructure. "Verification" for primitives and modules = the gate above + the **zero-regression visual contract**: the polished slice (shell + Dashboard + Pagamentos) must look pixel-identical after every task. Any visual delta there is an extraction defect, not an accepted change.
- **Manual Electron GUI smoke** (`npm.cmd run dev` → click through the touched module) is the USER's step, flagged at each delivery boundary. The executing agent cannot drive the Electron GUI and must hand off, not attempt it.

**Source-of-truth rule:** every primitive is extracted from the *existing* markup of the polished slice. Do not redesign during extraction. Reproduce the exact class names and visual behavior; only the call site changes.

---

## File Structure

**Created:**

- `src/renderer/types.ts` — shared cross-module types lifted out of App.tsx.
- `src/renderer/components/index.ts` — barrel re-export for clean module imports.
- `src/renderer/components/Card.tsx` — surface/panel container (+ optional header).
- `src/renderer/components/Badge.tsx` — status pill, tones `success|danger|info|neutral|accent`.
- `src/renderer/components/Button.tsx` — variants `primary|ghost|icon`.
- `src/renderer/components/Field.tsx` — label + input + error wrapper.
- `src/renderer/components/Select.tsx` — styled select consistent with Field.
- `src/renderer/components/Toolbar.tsx` — horizontal action/filter container.
- `src/renderer/components/EmptyState.tsx` — zero-data placeholder + optional action.
- `src/renderer/components/Message.tsx` — inline module error/success.
- `src/renderer/components/MetricCard.tsx` — single indicator card.
- `src/renderer/components/MetricGrid.tsx` — grid wrapper for MetricCard.
- `src/renderer/components/PageHeader.tsx` — eyebrow + title + right actions.
- `src/renderer/components/FilterBar.tsx` — composed: text search + select filters.
- `src/renderer/components/DataList.tsx` — composed: compact rows + badge + icon quick-actions.
- `src/renderer/components/DetailModal.tsx` — composed: entity detail/preview overlay.
- `src/renderer/components/ThemeToggle.tsx` — relocated from App.tsx.
- `src/renderer/modules/Dashboard.tsx`
- `src/renderer/modules/PaymentsModule.tsx`
- `src/renderer/modules/ClientsModule.tsx`
- `src/renderer/modules/PlansModule.tsx`
- `src/renderer/modules/ServicesModule.tsx`
- `src/renderer/modules/StockModule.tsx`
- `src/renderer/modules/ReportsModule.tsx`
- `src/renderer/modules/SettingsModule.tsx`

**Modified:**

- `src/renderer/App.tsx` — reduced to imports + `sections` nav array + `App()` shell/router (~250 lines target).
- `src/renderer/styles.css` — ONLY if a primitive needs a class the slice did not already have (additive; never edit existing token values or the legacy aliases).

**Unchanged (do not touch):** `src/renderer/main.tsx` (font imports stay before styles.css), `src/renderer/lib/format.ts`, everything under `src/backend/`, `src/main/`.

---

# DELIVERY 1 — Foundation (keystone)

Outcome: primitive layer exists; shell + Dashboard + PaymentsModule consume it with **zero visual regression**; App.tsx is shell+router only. This delivery proves the primitives against the source of truth.

### Task 1: Pre-work snapshot (rollback net)

**Files:** none modified.

- [ ] **Step 1: Create the snapshot**

Run from project root:

```powershell
Compress-Archive -Path src -DestinationPath ispm-pre-designprop-20260517.zip -Force
```

- [ ] **Step 2: Verify the archive exists and is non-empty**

```powershell
Get-Item ispm-pre-designprop-20260517.zip | Select-Object Name,Length
```

Expected: file listed, `Length` > 0.

### Task 2: Lift shared types into `types.ts`

**Files:**
- Create: `src/renderer/types.ts`
- Modify: `src/renderer/App.tsx` (top type block, currently ~lines 12–200)

- [ ] **Step 1: Identify cross-module types**

In `src/renderer/App.tsx`, the top-of-file `type` declarations include at least: `HealthState`, `SectionId`, `Client`, `ClientFormState`, `ServiceRow`, `PaymentRow`, `PlanRow`, and the remaining summary/form types (`DashboardSummary`, `StockSummary`, `StockCatalogRow`, `StockMovement`, etc.). A type is "shared" if it is referenced by App.tsx routing OR by more than one module. Module-private form-state types stay with their module (move them in that module's delivery, not now).

- [ ] **Step 2: Create `src/renderer/types.ts`**

Move every shared type declaration verbatim into `src/renderer/types.ts` and `export` each one. Keep names identical (renames here cascade into every later task — do not rename). Example shape:

```ts
export type HealthState = 'checking' | 'online' | 'offline';
export type SectionId = 'dashboard' | 'clients' | 'plans' | 'services' | 'payments' | 'stock' | 'reports' | 'settings';
export type Client = { id: number; clientCode: string; fullName: string; phone: string | null; email?: string | null; address?: string | null; island: string | null; zone: string | null; status: 'active' | 'suspended' | 'cancelled'; };
// ...remaining shared types, verbatim from App.tsx
```

- [ ] **Step 3: Replace the moved declarations in App.tsx with an import**

At the top of `App.tsx`, delete the moved `type` blocks and add:

```ts
import type { HealthState, SectionId /*, ...all shared types App.tsx still references */ } from './types';
```

- [ ] **Step 4: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0. Type-only move ⇒ zero behavior change.

### Task 3: Extract thin primitives (created, not yet wired)

**Files:** Create all thin-primitive files + `components/index.ts`. App.tsx not yet modified.

- [ ] **Step 1: Create `src/renderer/components/Message.tsx`**

Source of truth: Dashboard's `<p className="module-message error">{error}</p>`.

```tsx
type MessageProps = { tone?: 'error' | 'success'; children: React.ReactNode };
export function Message({ tone = 'error', children }: MessageProps) {
  return <p className={`module-message ${tone}`}>{children}</p>;
}
```

- [ ] **Step 2: Create `src/renderer/components/MetricCard.tsx` and `MetricGrid.tsx`**

Source of truth: Dashboard `.metric-grid` / `.metric-card` markup (icon, label `<span>`, value `<strong>`, trend `<small>`).

```tsx
// MetricCard.tsx
import type { LucideIcon } from 'lucide-react';
type MetricCardProps = { icon: LucideIcon; label: string; value: string; trend?: string };
export function MetricCard({ icon: Icon, label, value, trend }: MetricCardProps) {
  return (
    <article className="metric-card">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
      {trend ? <small>{trend}</small> : null}
    </article>
  );
}
```

```tsx
// MetricGrid.tsx
type MetricGridProps = { label: string; children: React.ReactNode };
export function MetricGrid({ label, children }: MetricGridProps) {
  return <section className="metric-grid" aria-label={label}>{children}</section>;
}
```

- [ ] **Step 3: Create `src/renderer/components/Card.tsx`**

Source of truth: Dashboard `.primary-panel` + `.section-heading` (`eyebrow` + `h2`).

```tsx
type CardProps = { eyebrow?: string; title?: string; actions?: React.ReactNode; className?: string; children: React.ReactNode };
export function Card({ eyebrow, title, actions, className, children }: CardProps) {
  return (
    <div className={`primary-panel${className ? ` ${className}` : ''}`}>
      {(eyebrow || title || actions) && (
        <div className="section-heading">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/renderer/components/Button.tsx`**

Variants: `primary` (uses `var(--accent)` bg — the design memo states primaries were deliberately converted from `var(--ink)` to `var(--accent)`; do NOT regress), `ghost`, `icon`. Reproduce the slice's existing primary/ghost/icon button classes. If the slice used bare `<button>` with utility classes, mirror those exact classes here; only add a `styles.css` rule if a class genuinely does not yet exist (additive only).

```tsx
import type { ButtonHTMLAttributes } from 'react';
type Variant = 'primary' | 'ghost' | 'icon';
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };
export function Button({ variant = 'primary', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn btn-${variant}${className ? ` ${className}` : ''}`} {...rest} />;
}
```

If `btn`/`btn-primary` etc. are not the slice's actual classes, replace them with the slice's real class names (inspect the polished PaymentsModule action buttons) and add only missing rules to `styles.css`.

- [ ] **Step 5: Create `Field.tsx`, `Select.tsx`, `Toolbar.tsx`, `EmptyState.tsx`, `PageHeader.tsx`**

```tsx
// Field.tsx
import type { InputHTMLAttributes } from 'react';
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string };
export function Field({ label, error, id, ...rest }: FieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input id={id} {...rest} />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
```

```tsx
// Select.tsx
import type { SelectHTMLAttributes } from 'react';
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string };
export function Select({ label, children, ...rest }: SelectProps) {
  const el = <select {...rest}>{children}</select>;
  return label ? <label className="field"><span className="field-label">{label}</span>{el}</label> : el;
}
```

```tsx
// Toolbar.tsx
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="toolbar">{children}</div>;
}
```

```tsx
// EmptyState.tsx
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  );
}
```

```tsx
// PageHeader.tsx
export function PageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; actions?: React.ReactNode }) {
  return (
    <header className="topbar">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      {actions ? <div className="topbar-actions">{actions}</div> : null}
    </header>
  );
}
```

For `field`, `field-label`, `field-error`, `toolbar`, `empty-state`: reuse the slice's existing classes if present; otherwise add minimal additive rules to `styles.css` using existing tokens (`--surface`, `--border`, `--text-2`, `--s3`, etc.) — no new tokens, no alias edits.

- [ ] **Step 6: Create `src/renderer/components/Badge.tsx`**

Source of truth: PaymentsModule status badges. Map payment statuses to tones: `paid→success`, `pending→info`, `overdue→danger`, `cancelled→neutral`. (Corrected during Task 3: the slice's `.payment-status.pending` uses info tones and `.payment-status.cancelled` uses the muted surface treatment — collapsing both to one tone would visibly regress Pagamentos. The 5-tone badge vocabulary reproduces all four pills exactly: `.badge-success`=`.payment-status.paid`, `.badge-info`=`.pending`, `.badge-danger`=`.overdue`, `.badge-neutral`=`.cancelled`.) Reproduce the slice's exact badge class.

```tsx
type Tone = 'success' | 'danger' | 'info' | 'neutral' | 'accent';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
```

If the slice's badge classes differ, use the real ones and only add missing tone rules to `styles.css` (additive, token-based).

- [ ] **Step 7: Create `src/renderer/components/index.ts` barrel**

```ts
export * from './Message';
export * from './MetricCard';
export * from './MetricGrid';
export * from './Card';
export * from './Button';
export * from './Field';
export * from './Select';
export * from './Toolbar';
export * from './EmptyState';
export * from './PageHeader';
export * from './Badge';
```

- [ ] **Step 8: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0. New unused files compile; nothing wired yet ⇒ zero visual change.

### Task 4: Extract composed patterns

**Files:** Create `FilterBar.tsx`, `DataList.tsx`, `DetailModal.tsx`; extend the barrel.

- [ ] **Step 1: Create `src/renderer/components/FilterBar.tsx`**

Source of truth: the Pagamentos/Stock filter row (a text input + one or more `<select>` filters inside a `Toolbar`).

```tsx
export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}
```

`FilterBar` is a layout shell; callers pass `Field`/`Select` instances. Reuse the slice's existing filter-row class if it has one.

- [ ] **Step 2: Create `src/renderer/components/DataList.tsx`**

Source of truth: PaymentsModule's compact row list (row + status `Badge` + icon quick-action buttons). Generic over the row type:

```tsx
type Column<T> = { header: string; cell: (row: T) => React.ReactNode };
type DataListProps<T> = {
  rows: T[];
  rowKey: (row: T) => string | number;
  columns: Column<T>[];
  actions?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
  empty: React.ReactNode;
};
export function DataList<T>({ rows, rowKey, columns, actions, onRowClick, empty }: DataListProps<T>) {
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="data-list">
      {rows.map((row) => (
        <div className="data-row" key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}>
          {columns.map((c, i) => <div className="data-cell" key={i}>{c.cell(row)}</div>)}
          {actions ? <div className="data-actions">{actions(row)}</div> : null}
        </div>
      ))}
    </div>
  );
}
```

Use the slice's real row/cell classes if they exist; otherwise additive rules in `styles.css`.

- [ ] **Step 3: Create `src/renderer/components/DetailModal.tsx`**

Source of truth: PaymentsModule's `selectedPayment` block in App.tsx (lines ~1306–1473). **Corrected during Task 4: the plan originally specced a backdrop modal (`modal-backdrop`/`modal-panel`/`modal-head`/`modal-foot`, `role="dialog"`, `aria-modal`, Escape). Those classes do not exist in the slice and that shape is falsified — PaymentsModule's `selectedPayment` is an INLINE `client-detail` panel rendered above the list, not a modal. Reproducing the real shell is the binding source-of-truth rule; the original placeholder is discarded.** The real shell: `<div className="client-detail">` → `<div className="module-header">` containing a left `<div>` with an optional `<p className="eyebrow">` then `<h2>`, and a right `<div className="inline-actions">` where the caller's context action buttons render, followed by a **bare** `<button type="button" title="Fechar">` (content `<X size={16} />` only — NOT `.btn btn-icon`, no text) as the last `inline-actions` child; then `{children}` as the panel body. No footer, no backdrop, no `role="dialog"`/`aria-modal`/Escape (an inline panel is not modal — those would misrepresent it; the only a11y add is `aria-label="Fechar"` mirroring the existing `title`). The `X` icon is already imported from `lucide-react`.

```tsx
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
type DetailModalProps = { title: ReactNode; onClose: () => void; children: ReactNode; eyebrow?: string; actions?: ReactNode; className?: string; id?: string };
export function DetailModal({ title, onClose, children, eyebrow, actions, className, id }: DetailModalProps) {
  return (
    <div className={className ? `client-detail ${className}` : 'client-detail'} id={id}>
      <div className="module-header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
        </div>
        <div className="inline-actions">
          {actions}
          <button type="button" title="Fechar" aria-label="Fechar" onClick={onClose}><X size={16} /></button>
        </div>
      </div>
      {children}
    </div>
  );
}
```

`client-detail`, `module-header`, `inline-actions`, `eyebrow` all already have rules in styles.css — zero additive CSS. Name stays `DetailModal` (barrel/Task 6 contract) though it is an inline panel, not a modal.

- [ ] **Step 4: Extend `components/index.ts`**

Append:

```ts
export * from './FilterBar';
export * from './DataList';
export * from './DetailModal';
```

- [ ] **Step 5: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0.

### Task 5: Move ThemeToggle + Dashboard to consume primitives

**Files:**
- Create: `src/renderer/components/ThemeToggle.tsx`, `src/renderer/modules/Dashboard.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Move `ThemeToggle`**

Cut the entire `ThemeToggle` function from App.tsx into `src/renderer/components/ThemeToggle.tsx` verbatim, add `export`, and add `export * from './ThemeToggle';` to the barrel. Replace its use in App.tsx with an import.

- [ ] **Step 2: Move `Dashboard` into its module file**

Cut the entire `Dashboard` function into `src/renderer/modules/Dashboard.tsx`. Add `export function Dashboard(...)`. Import shared types from `../types` and primitives from `../components`.

- [ ] **Step 3: Refactor Dashboard markup to primitives**

Replace inline markup with primitives, preserving identical DOM output:
- `<p className="module-message error">` → `<Message tone="error">`
- `<section className="metric-grid" aria-label="Indicadores">` + `.metric-card` map → `<MetricGrid label="Indicadores">` + `<MetricCard .../>` per metric
- `.primary-panel` + `.section-heading` → `<Card eyebrow="Hoje" title="Fila de trabalho">`
- empty work queue branch → `<EmptyState .../>` only if the slice already showed an empty state there; otherwise keep existing markup.

- [ ] **Step 4: Wire App.tsx**

Add `import { Dashboard } from './modules/Dashboard';`. The `{section === 'dashboard' && <Dashboard onOpenClients={() => setSection('clients')} />}` line is unchanged.

- [ ] **Step 5: Zero-regression visual self-check**

Confirm rendered DOM/classes for Dashboard are identical to pre-refactor (same element tags, same class strings, same order). Any delta ⇒ fix the primitive, not the module.

- [ ] **Step 6: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0.

### Task 6: Move PaymentsModule to consume primitives

**Files:**
- Create: `src/renderer/modules/PaymentsModule.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Move the module**

Cut `PaymentsModule` (and any payment-only helper functions/types it owns) into `src/renderer/modules/PaymentsModule.tsx`. Shared types from `../types`; payment-private types stay local. Import primitives from `../components`.

- [ ] **Step 2: Refactor markup to primitives, preserving behavior**

Map, without changing logic or DOM semantics:
- filter row → `<FilterBar>` with `Field`/`Select`
- compact payment list → `<DataList>` (columns + `Badge` for status + `Button variant="icon"` quick actions for the existing pay/print/download/cancel actions)
- the `selectedPayment` panel → `<DetailModal eyebrow="Pre-visualizacao" title={selectedPayment.clientName} className="payment-preview" id="payment-preview" onClose={…} actions={…}>`: pass the existing PDF/registar-pagamento/WhatsApp/Anular buttons (the `inline-actions payment-preview-actions` content) via the `actions` prop — the close button is rendered by `DetailModal` itself, do NOT duplicate it; the action forms + `document-preview` + iframe/`module-message` + `dl` become `children`. `client-detail payment-preview` + `id="payment-preview"` must be preserved for pixel-identical output (DetailModal §3). It is an inline panel, not a modal — no behavior change.
- inline error/success → `<Message>`
- status pill → `<Badge tone>` with mapping `paid→success`, `pending→info`, `overdue→danger`, `cancelled→neutral` (mapping corrected in Task 3 for pixel-identical reproduction of the four existing `.payment-status` treatments — see Task 3 §6 note)
All existing handlers (`cancelPayment`, `openPdf`, `previewPaymentDocument`, mark-as-paid) keep identical call signatures and behavior.

- [ ] **Step 3: Wire App.tsx**

Add `import { PaymentsModule } from './modules/PaymentsModule';`. Routing line unchanged.

- [ ] **Step 4: Zero-regression visual self-check**

Pagamentos must look pixel-identical and every action must still work (preview, cancel, mark paid, open invoice/receipt PDF).

- [ ] **Step 5: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0.

### Task 7: Reduce App.tsx to shell + router; Delivery 1 checkpoint

**Files:** Modify `src/renderer/App.tsx`.

- [ ] **Step 1: Trim App.tsx**

App.tsx must now contain only: imports, the `sections` nav array, and `App()` (shell sidebar + `PageHeader`/topbar + the `{section === ...}` router). Refactor the topbar to use `<PageHeader>` only if it produces identical DOM. Target ≤ ~250 lines. No module bodies, no `ThemeToggle` body, no shared type declarations remain.

- [ ] **Step 2: Validation gate + production build**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
npm.cmd run build
```

For `npm.cmd run build`: success is reaching/passing `vite build`. If it then fails inside `electron-builder` on `better-sqlite3`/`node-gyp`, that is the KNOWN pre-existing environment blocker — record "vite build OK, electron-builder env blocker as documented" and treat the task as passing. Do NOT attempt to fix `node-gyp`.

- [ ] **Step 3: Delivery 1 snapshot checkpoint**

```powershell
Compress-Archive -Path src -DestinationPath ispm-delivery1-foundation-20260517.zip -Force
```

- [ ] **Step 4: Hand off manual smoke to the user**

Stop. Report: "Delivery 1 done. Please run `npm.cmd run dev` and confirm shell + Dashboard + Pagamentos are visually unchanged and Pagamentos actions still work, before Delivery 2." Do not start Delivery 2 until the user confirms.

---

# DELIVERIES 2–7 — One module per delivery

Each delivery is the SAME task shape applied to one module, in this order: **2 Clientes → 3 Planos → 4 Serviços → 5 Stock → 6 Relatórios → 7 Definições**. Stop for user review + manual smoke after each.

Per-delivery task (substitute the module each time):

### Task D.1: Move `<Module>` into its own file

**Files:**
- Create: `src/renderer/modules/<Module>.tsx`
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1:** Cut the entire module function (and its module-private helpers + form-state types) from App.tsx into `src/renderer/modules/<Module>.tsx`. `export` it. Import shared types from `../types`, primitives from `../components`. Keep module-private types local to this file.
- [ ] **Step 2:** Add `import { <Module> } from './modules/<Module>';` in App.tsx. The `{section === '<id>' && <<Module> />}` routing line is unchanged.
- [ ] **Step 3: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0. (Pure move so far — still old markup, just relocated.)

### Task D.2: Rebuild the module markup bespoke on primitives

**Files:** Modify `src/renderer/modules/<Module>.tsx` only.

- [ ] **Step 1: Replace generic markup section by section** using the primitive layer, matching the editorial language of the polished slice (Fraunces display type, OKLCH tokens, hairline borders, no glow). Required primitive usage per module:
  - **Clientes:** `PageHeader` (or section heading) · `FilterBar` (text + status/island/zone selects, matching current filters) · `DataList` (client rows + `Badge` for status `active→success / suspended→neutral / cancelled→danger`) · `DetailModal` for the selected-client view · the existing WhatsApp action as a `Button variant="ghost"`/`icon` · create/edit form via `Field`/`Select` · `Message` for errors · `EmptyState` when no clients match.
  - **Planos:** `Card`/list of plans · `FilterBar` (text + connection type + active state, matching current filters) · `Badge` for active/inactive · `Field`/`Select` form for create/edit · `Message` · `EmptyState`.
  - **Serviços:** `DataList` of services · `Badge` for service status · `DetailModal`/form using `Field`/`Select` for create/edit · `Message` · `EmptyState`.
  - **Stock:** `MetricGrid`/`MetricCard` for stock summary if the module shows totals · `FilterBar` (text + type + low/out filter) · `DataList` for catalog rows · `DetailModal` for the selected-catalog + movements view · `Field`/`Select` for catalog/movement forms · `Badge` for low/out tone · `Message` · `EmptyState`.
  - **Relatórios:** `Card` per report section · `FilterBar`/period selectors as currently present · `DataList` for tabular rows · keep the existing CSV export action as a `Button` · `EmptyState` for no data. Do not change export behavior.
  - **Definições:** `Card` per settings group · `Field`/`Select` for company profile / billing defaults / document prefixes / UltraMsg fields · `Button` for save. **The shipped `BackupsPanel` is presentation-only re-skin: wrap its existing controls in `Card`/`Button`/`Message` but DO NOT modify backup/restore logic, the `app:relaunch` IPC, `db.backup()`, or the `journal_mode = DELETE` normalization. Its handlers and effects stay byte-for-byte.**
- [ ] **Step 2: Behavior-preservation check** — every handler, fetch URL, form submit, and state transition is unchanged; only presentation changed. Confirm the module's data flows are identical to pre-rebuild.
- [ ] **Step 3: Validation gate**

```powershell
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json
npm.cmd test
```

Expected: all exit 0.

- [ ] **Step 4: Polished-slice regression guard** — Dashboard and Pagamentos must STILL be pixel-identical (shared primitives changed nothing for them). If they shifted, a primitive was mutated for one module's convenience — revert that and compose at the call site instead.

### Task D.3: Delivery checkpoint + user handoff

- [ ] **Step 1: Delivery snapshot**

```powershell
Compress-Archive -Path src -DestinationPath ispm-delivery<N>-<module>-20260517.zip -Force
```

- [ ] **Step 2: Hand off** — Stop. Report which module shipped, gate results, and: "Please run `npm.cmd run dev`, click through <Module> and the polished slice, confirm parity and that nothing regressed, before the next delivery." Do not proceed until the user confirms.

---

## Self-Review

**1. Spec coverage:**
- Goal (bespoke parity, primitive layer, module split, App.tsx → router) → Tasks 3–7 + Deliveries 2–7. ✓
- Non-Goals (no routing lib / CSS-in-JS / Storybook / new deps / feature change) → enforced in Execution Conventions + source-of-truth rule. ✓
- Architecture file structure → File Structure section matches spec exactly. ✓
- Hybrid primitive layer (thin + FilterBar/DataList/DetailModal) → Tasks 3 & 4. ✓
- Delivery 1 zero-regression contract → Tasks 5 §5, 6 §4, 7; regression guard in D.2 §4. ✓
- Delivery order Clientes→…→Definições → Deliveries 2–7 header. ✓
- Definições BackupsPanel guardrail → D.2 §1 Definições bullet (explicit byte-for-byte prohibition). ✓
- No-git zip safety + validation gate + manual smoke → Execution Conventions + Task 1 + per-delivery checkpoints. ✓
- Known electron-builder env blocker not to be "fixed" → Task 7 §2. ✓
No uncovered spec requirements.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". Component code is concrete; module-rebuild tasks specify exact primitive mappings and the behavior-preservation contract rather than fabricated JSX (the live polished slice is the deliberate, spec-mandated oracle — not a placeholder). ✓

**3. Type consistency:** Shared types defined once in Task 2 (`src/renderer/types.ts`), imported via `../types` everywhere; primitives exported through a single `components/index.ts` barrel and imported via `../components` consistently across all tasks. `Badge` tone names (`success|danger|info|neutral|accent`) are identical in Task 3 §6 and every module mapping in D.2. `DataList`/`DetailModal`/`FilterBar` prop names defined in Task 4 are the same names referenced in Deliveries 2–7. ✓

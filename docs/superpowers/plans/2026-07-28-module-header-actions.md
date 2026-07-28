# Module Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a semantic, premium action system for ISPM module headers while preserving permissions and business behaviour.

**Architecture:** Extend the shared `Button` primitive with an explicit `critical` variant and action-specific design tokens, then add a layout-only `ModuleHeaderActions` composition with named context, secondary, critical and primary regions. Remove the contextual CSS rule that promotes every header button, migrate module headers to explicit semantic roles, and validate the resulting hierarchy in dark, light and constrained-width browser scenarios.

**Tech Stack:** React 19, TypeScript 5.7, CSS/OKLCH design tokens, Lucide React, Vitest 2 with jsdom, Vite 7, Playwright visual audit.

## Global Constraints

- Scope is limited to module headers and the shared `Button` primitive.
- Preserve every permission check, callback, API call, confirmation flow and domain operation.
- Every mapped module header has no more than one primary action.
- Primary actions use the ISPM blue/cyan family in dark and light modes.
- Header actions use the default 40 px Button size, 10–11 px radius and 16 px icons.
- `Button` is the only owner of button colour, border, materiality and state styling.
- `ModuleHeaderActions` owns layout only and must not clone or restyle children.
- Keep native button semantics; grouped commands use `role="group"`, not `role="toolbar"`.
- Support `prefers-reduced-motion`, WCAG AA contrast, visible focus, stable loading width and legible disabled states.
- Do not introduce an overflow menu or hide any existing command.
- Do not add dependencies.
- Design specification: `docs/superpowers/specs/2026-07-27-module-header-actions-design.md`.

---

### Task 1: Strengthen the shared Button primitive

**Files:**
- Create: `src/renderer/components/Button.test.tsx`
- Modify: `src/renderer/components/Button.tsx`

**Interfaces:**
- Consumes: native `ButtonHTMLAttributes<HTMLButtonElement>`, React nodes and Lucide `Loader2`.
- Produces: exported `Button` with `variant?: 'primary' | 'secondary' | 'ghost' | 'critical' | 'danger' | 'icon'`, existing sizes and stable loading semantics.

- [ ] **Step 1: Write the failing Button contract tests**

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  test('renders the restrained critical variant explicitly', () => {
    const html = renderToStaticMarkup(<Button variant="critical">Reverter</Button>);
    expect(html).toContain('btn btn-critical');
    expect(html).not.toContain('btn-danger');
  });

  test('keeps loading state native, accessible and dimensionally stable', () => {
    const html = renderToStaticMarkup(<Button loading>Guardar</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('btn-loading');
    expect(html).toContain('btn-content');
    expect(html).toContain('btn-spinner');
    expect(html).toContain('Guardar');
  });

  test('keeps the default header-compatible size free of a size modifier', () => {
    const html = renderToStaticMarkup(<Button>Novo cliente</Button>);
    expect(html).toContain('class="btn btn-primary"');
    expect(html).not.toContain('btn-sm');
  });
});
```

- [ ] **Step 2: Run the focused test and TypeScript contract**

Run:

```powershell
npx.cmd vitest run src/renderer/components/Button.test.tsx
npx.cmd tsc --noEmit
```

Expected: the runtime test can render the string-based class, but TypeScript
FAILS because `critical` is not assignable to the current `Variant`.

- [ ] **Step 3: Add the critical variant without changing the Button’s native contract**

Update the local variant union:

```tsx
type Variant = 'primary' | 'secondary' | 'ghost' | 'critical' | 'danger' | 'icon';
```

Keep native `disabled` and `aria-busy`, but make loading dimensionally stable
by retaining the normal content as the sizing box and overlaying the spinner:

```tsx
<button
  type={type}
  className={classes.join(' ')}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  {...rest}
>
  <span className="btn-content">
    {leadingIcon}
    {children}
    {trailingIcon}
  </span>
  {loading ? <Loader2 size={16} className="btn-spinner" aria-hidden /> : null}
</button>
```

The content remains in the accessibility tree while CSS in Task 3 visually
mutes it during loading. Do not add header knowledge to this component.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
npx.cmd vitest run src/renderer/components/Button.test.tsx
npx.cmd tsc --noEmit
```

Expected: both commands PASS.

- [ ] **Step 5: Commit the Button contract**

```powershell
git add src/renderer/components/Button.tsx src/renderer/components/Button.test.tsx
git commit -m "feat: add critical button semantics"
```

---

### Task 2: Add the semantic module-header composition

**Files:**
- Create: `src/renderer/components/ModuleHeaderActions.tsx`
- Create: `src/renderer/components/ModuleHeaderActions.test.tsx`
- Modify: `src/renderer/components/index.ts`

**Interfaces:**
- Consumes: `ReactNode`, one optional `ReactElement` primary action and ordinary `className`.
- Produces:

```ts
export type ModuleHeaderActionsProps = {
  context?: ReactNode;
  secondary?: ReactNode;
  critical?: ReactNode;
  primary?: ReactElement;
  ariaLabel?: string;
  className?: string;
};

export function ModuleHeaderActions(props: ModuleHeaderActionsProps): ReactElement;
```

- [ ] **Step 1: Write failing structure and accessibility tests**

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from './Button';
import { ModuleHeaderActions } from './ModuleHeaderActions';

describe('ModuleHeaderActions', () => {
  test('keeps context outside the named command group and preserves semantic order', () => {
    const html = renderToStaticMarkup(
      <ModuleHeaderActions
        ariaLabel="Ações de pagamentos"
        context={<label>Mês<input type="month" /></label>}
        secondary={<Button variant="secondary">Notificar</Button>}
        critical={<Button variant="critical">Reverter</Button>}
        primary={<Button>Gerar</Button>}
      />
    );

    expect(html).toContain('module-header-context');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Ações de pagamentos"');
    expect(html.indexOf('Notificar')).toBeLessThan(html.indexOf('Reverter'));
    expect(html.indexOf('Reverter')).toBeLessThan(html.indexOf('Gerar'));
  });

  test('omits empty regions instead of emitting decorative wrappers', () => {
    const html = renderToStaticMarkup(
      <ModuleHeaderActions primary={<Button>Novo plano</Button>} />
    );

    expect(html).not.toContain('module-header-context');
    expect(html).not.toContain('module-header-actions-critical');
    expect(html).toContain('Novo plano');
  });
});
```

- [ ] **Step 2: Run the focused test and verify the component is missing**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.test.tsx
```

Expected: FAIL because `./ModuleHeaderActions` does not exist.

- [ ] **Step 3: Implement the layout-only composition**

```tsx
import type { ReactElement, ReactNode } from 'react';

export type ModuleHeaderActionsProps = {
  context?: ReactNode;
  secondary?: ReactNode;
  critical?: ReactNode;
  primary?: ReactElement;
  ariaLabel?: string;
  className?: string;
};

export function ModuleHeaderActions({
  context,
  secondary,
  critical,
  primary,
  ariaLabel = 'Ações do módulo',
  className
}: ModuleHeaderActionsProps) {
  const hasCommands = Boolean(secondary || critical || primary);
  const classes = ['module-header-actions', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {context ? <div className="module-header-context">{context}</div> : null}
      {hasCommands ? (
        <div className="module-header-commands" role="group" aria-label={ariaLabel}>
          {secondary ? <div className="module-header-actions-secondary">{secondary}</div> : null}
          {critical ? <div className="module-header-actions-critical">{critical}</div> : null}
          {primary ? <div className="module-header-actions-primary">{primary}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
```

Export it from `src/renderer/components/index.ts`:

```ts
export * from './ModuleHeaderActions';
```

- [ ] **Step 4: Run component tests and typecheck**

Run:

```powershell
npx.cmd vitest run src/renderer/components/Button.test.tsx src/renderer/components/ModuleHeaderActions.test.tsx
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit the composition**

```powershell
git add src/renderer/components/ModuleHeaderActions.tsx src/renderer/components/ModuleHeaderActions.test.tsx src/renderer/components/index.ts
git commit -m "feat: add semantic module header actions"
```

---

### Task 3: Build the visual contract and remove the cascade defect

**Files:**
- Create: `src/renderer/components/ModuleHeaderActions.styles.test.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: existing theme primitives (`--surface-*`, `--border-*`,
  `--danger`, motion/radius tokens) and the class contract from Tasks 1–2.
- Produces: action-specific CSS tokens, complete Button state styles and
  responsive `.module-header-actions*` layout.

- [ ] **Step 1: Write a failing CSS regression test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('module header action styles', () => {
  test('does not contextually promote every module-header button', () => {
    expect(css).not.toMatch(/\.module-header button\s*,/);
    expect(css).not.toMatch(/\.module-header button:hover/);
    expect(css).not.toMatch(/\.module-header button:active/);
  });

  test('defines action-specific theme tokens and semantic variants', () => {
    expect(css).toContain('--action-primary-start:');
    expect(css).toContain('--action-primary-end:');
    expect(css).toContain('.btn-critical');
    expect(css).toContain('.module-header-actions');
    expect(css).toContain('.module-header-actions-critical');
  });

  test('respects reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.btn/);
  });
});
```

- [ ] **Step 2: Run the style test and verify the legacy selector is caught**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.styles.test.ts
```

Expected: FAIL on the legacy `.module-header button` selector and missing new
tokens/classes.

- [ ] **Step 3: Add action tokens for dark and light themes**

Add dark defaults under `:root` and override surfaces as needed under
`:root[data-theme="light"]`. Use the approved blue identity in both themes:

```css
--action-primary-start: oklch(72% 0.15 246);
--action-primary-end: oklch(62% 0.18 258);
--action-primary-fg: oklch(16% 0.025 251);
--action-primary-border: color-mix(in oklch, var(--action-primary-start) 76%, white);
--action-primary-shadow:
  0 1px 0 oklch(100% 0 0 / 0.18) inset,
  0 8px 18px -10px oklch(58% 0.18 252 / 0.8);
--action-secondary-bg: color-mix(in oklch, var(--surface-2) 88%, transparent);
--action-secondary-hover: var(--surface-3);
--action-secondary-border: color-mix(in oklch, var(--border-2) 72%, transparent);
--action-focus: color-mix(in oklch, var(--action-primary-start) 66%, transparent);
```

For light mode, use a deeper blue pair with white foreground:

```css
--action-primary-start: oklch(60% 0.18 249);
--action-primary-end: oklch(51% 0.19 260);
--action-primary-fg: oklch(99% 0.004 250);
--action-primary-border: color-mix(in oklch, var(--action-primary-end) 84%, black);
--action-primary-shadow:
  0 1px 0 oklch(100% 0 0 / 0.32) inset,
  0 10px 22px -14px oklch(47% 0.16 254 / 0.52);
```

Tune values only if browser contrast inspection shows a failure; keep the hue
family and semantic roles unchanged.

- [ ] **Step 4: Replace the legacy Button CSS with the approved state system**

Remove `.module-header button` from the broad selector and its hover/active
selectors. Rebuild `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`,
`.btn-critical`, `.btn-danger`, `.btn-icon`, loading and disabled rules around
the new action tokens.

The implementation must include:

```css
.btn {
  position: relative;
  min-height: 40px;
  border-radius: var(--r2);
  gap: var(--space-2);
  padding: 0 var(--space-4);
  transition:
    transform var(--motion-fast) var(--ease-out),
    background var(--motion-base) var(--ease-out),
    border-color var(--motion-base) var(--ease-out),
    box-shadow var(--motion-base) var(--ease-out),
    color var(--motion-base) var(--ease-out);
}

.btn-content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.btn-loading .btn-content {
  opacity: 0;
}

.btn-spinner {
  position: absolute;
  inset: 0;
  margin: auto;
}

.btn:focus-visible {
  outline: 2px solid var(--action-focus);
  outline-offset: 2px;
}

.btn-primary {
  border: 1px solid var(--action-primary-border);
  background: linear-gradient(145deg, var(--action-primary-start), var(--action-primary-end));
  box-shadow: var(--action-primary-shadow);
  color: var(--action-primary-fg);
}

.btn-critical {
  border: 1px solid var(--action-secondary-border);
  background: var(--action-secondary-bg);
  color: var(--danger);
}

.btn-critical:hover,
.btn-critical:focus-visible {
  border-color: color-mix(in oklch, var(--danger) 58%, var(--border));
  background: color-mix(in oklch, var(--danger-bg) 72%, var(--surface-2));
}

@media (prefers-reduced-motion: reduce) {
  .btn {
    transition-duration: 1ms;
  }

  .btn:hover,
  .btn:active {
    transform: none;
  }
}
```

The final hover/active transforms must not cause layout shift, and disabled
buttons must not lift or brighten.

- [ ] **Step 5: Add responsive composition layout**

Implement `.module-header-actions`, `.module-header-context`,
`.module-header-commands` and their three semantic groups. Use flex wrapping,
stable group order and a subtle separator before critical actions. At the
existing responsive module-header breakpoint, move the composition to a new
row and let the Payments context occupy a usable width.

- [ ] **Step 6: Run style, component and type checks**

Run:

```powershell
npx.cmd vitest run src/renderer/components/Button.test.tsx src/renderer/components/ModuleHeaderActions.test.tsx src/renderer/components/ModuleHeaderActions.styles.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit the visual contract**

```powershell
git add src/renderer/styles.css src/renderer/components/ModuleHeaderActions.styles.test.ts
git commit -m "style: establish premium header action hierarchy"
```

---

### Task 4: Migrate Clients, Services and Payments as the reference slice

**Files:**
- Create: `src/renderer/modules/ModuleHeaderActionMapping.test.tsx`
- Modify: `src/renderer/modules/ClientsModule.tsx`
- Modify: `src/renderer/modules/ServicesModule.tsx`
- Modify: `src/renderer/modules/PaymentsModule.tsx`

**Interfaces:**
- Consumes: `ModuleHeaderActions` and Button variants from Tasks 1–2.
- Produces: the reference semantic mapping used by every later module.

- [ ] **Step 1: Write failing integration assertions for the reference headers**

Create the jsdom harness with explicit providers, auth bypass and isolated
empty API responses:

```tsx
/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';
import { PaymentsModule } from './PaymentsModule';
import { ServicesModule } from './ServicesModule';

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>{element}</ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
  });

  return container;
}

function action(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`Action not found: ${label}`);
  return button;
}

function expectVariant(container: HTMLElement, label: string, variant: string) {
  expect(action(container, label).classList.contains(`btn-${variant}`)).toBe(true);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return jsonResponse({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/audiovisual-config')) return jsonResponse(null);
    if (url.endsWith('/api/settings')) return jsonResponse({});
    return jsonResponse([]);
  }));
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
```

Add these exact assertions:

```tsx
expectVariant(container, 'Importar', 'secondary');
expectVariant(container, 'Novo cliente', 'primary');
expectVariant(container, 'Atribuir IPs', 'secondary');
expectVariant(container, 'Novo servico', 'primary');
expectVariant(container, 'Notificar atrasados', 'secondary');
expectVariant(container, 'Avisar suspensao', 'secondary');
expectVariant(container, 'Reverter mensalidades', 'critical');
expectVariant(container, 'Gerar mensalidades', 'primary');
```

For each mounted header:

```tsx
const commandGroup = container.querySelector('[role="group"][aria-label^="Ações"]');
expect(commandGroup).not.toBeNull();
expect(commandGroup?.querySelectorAll('.btn-primary')).toHaveLength(1);
```

- [ ] **Step 2: Run the integration test and verify the missing hierarchy**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/ModuleHeaderActionMapping.test.tsx
```

Expected: FAIL because the modules do not render `ModuleHeaderActions`,
Payments has no primary/critical distinction, and Clients/Services primary
buttons lack the approved composition.

- [ ] **Step 3: Migrate Clients**

Import `Plus` and `ModuleHeaderActions`. Replace the header’s `inline-actions`
with:

```tsx
<ModuleHeaderActions
  ariaLabel="Ações de clientes"
  secondary={
    <Button variant="secondary" leadingIcon={<Upload size={16} aria-hidden />} onClick={() => setShowImport(true)}>
      Importar
    </Button>
  }
  primary={
    <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>
      Novo cliente
    </Button>
  }
/>
```

Keep the existing `canManageClients` guard around the entire composition.

- [ ] **Step 4: Migrate Services**

Import `Network` and `Plus` from Lucide and `ModuleHeaderActions` from the
component barrel. Render `Atribuir IPs` as secondary with a 16 px `Network`
icon when `canRecordTechnical`; render `Novo servico` as primary with `Plus`
when `canManageServices`. Keep each existing permission condition unchanged.

- [ ] **Step 5: Migrate Payments**

Import `CalendarPlus` and `ModuleHeaderActions`. Replace the `inline-actions`
run with:

```tsx
<ModuleHeaderActions
  ariaLabel="Ações de pagamentos"
  context={
    <Field label="Mes" type="month" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)} />
  }
  secondary={
    <>
      <Button variant="secondary" leadingIcon={<Send size={16} aria-hidden />} onClick={() => void openOverduePreview()} disabled={notifyLoading}>
        {notifyLoading ? 'A consultar...' : 'Notificar atrasados'}
      </Button>
      <Button variant="secondary" leadingIcon={<AlertTriangle size={16} aria-hidden />} onClick={() => void openOverduePreview('suspension')} disabled={notifyLoading}>
        Avisar suspensao
      </Button>
    </>
  }
  critical={
    <Button variant="critical" leadingIcon={<RotateCcw size={16} aria-hidden />} onClick={() => void openReversePreview()} disabled={reverseLoading} title="Reverter mensalidades geradas para este mes">
      {reverseLoading ? 'A consultar...' : 'Reverter mensalidades'}
    </Button>
  }
  primary={
    <Button leadingIcon={<CalendarPlus size={16} aria-hidden />} onClick={() => void openMonthlyPreview()} disabled={monthlyLoading}>
      {monthlyLoading && !monthlyPreview ? 'A calcular...' : 'Gerar mensalidades'}
    </Button>
  }
/>
```

Do not alter callback bodies, disabled conditions, preview state or month
state.

- [ ] **Step 6: Run reference integration tests and regression tests**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/ModuleHeaderActionMapping.test.tsx src/renderer/modules/OperationalDefaultFilters.test.tsx
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit the reference migration**

```powershell
git add src/renderer/modules/ClientsModule.tsx src/renderer/modules/ServicesModule.tsx src/renderer/modules/PaymentsModule.tsx src/renderer/modules/ModuleHeaderActionMapping.test.tsx
git commit -m "feat: apply header action hierarchy to core modules"
```

---

### Task 5: Propagate the semantic composition to remaining module headers

**Files:**
- Modify: `src/renderer/modules/ModuleHeaderActionMapping.test.tsx`
- Modify: `src/renderer/modules/PlansModule.tsx`
- Modify: `src/renderer/modules/StockModule.tsx`
- Modify: `src/renderer/modules/UsersModule.tsx`
- Modify: `src/renderer/modules/WorkOrdersModule.tsx`
- Modify: `src/renderer/modules/ExpensesModule.tsx`
- Modify: `src/renderer/modules/ExpensesModule.css`
- Modify: `src/renderer/modules/InvestmentsModule.tsx`
- Modify: `src/renderer/modules/AuditModule.tsx`
- Modify: `src/renderer/modules/ReportsModule.tsx`
- Modify: `src/renderer/modules/ProfitModule.tsx`
- Modify: `src/renderer/modules/payments/MonthlyBillingPreview.tsx`

**Interfaces:**
- Consumes: the reference composition and variant mapping from Task 4.
- Produces: consistent module-level header hierarchy across the renderer.

- [ ] **Step 1: Extend the integration test with the approved mapping**

Add module cases and assert:

```tsx
expectVariant(plans, 'Novo plano', 'primary');
expectVariant(users, 'Novo utilizador', 'primary');
expectVariant(workOrders, 'Nova OS', 'primary');
expectVariant(expenses, 'Recorrentes', 'secondary');
expectVariant(expenses, 'Nova despesa', 'primary');
expectVariant(investments, 'Novo investimento', 'primary');
expectVariant(audit, 'Atualizar', 'secondary');
expectVariant(reports, 'Exportar CSV', 'secondary');
expectVariant(profit, 'PDF', 'secondary');
expectVariant(profit, 'Excel', 'secondary');
```

Also assert that every `.module-header-commands` in the mounted cases contains
at most one `.btn-primary`.

For modules whose data request must remain pending during the header test,
return a never-resolving promise after the auth bootstrap; the header must be
assertable without exercising business data.

- [ ] **Step 2: Run the expanded mapping test and verify it fails**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/ModuleHeaderActionMapping.test.tsx
```

Expected: FAIL because the remaining headers still use direct Buttons or
`inline-actions`.

- [ ] **Step 3: Migrate single-primary create headers**

For Plans, Users and Work Orders:

- wrap the existing create Button in `ModuleHeaderActions primary={...}`;
- retain each permission condition;
- use the default 40 px size;
- add a 16 px `Plus` leading icon where missing;
- retain the current label and callback exactly.

For Stock:

- list header: primary `Novo material/equipamento`;
- selected item header: secondary `Editar`, primary `Movimento`;
- preserve the `canManageStock` conditions and selected-item behaviour.

- [ ] **Step 4: Migrate financial create headers**

For Expenses:

```tsx
<ModuleHeaderActions
  ariaLabel="Ações de despesas"
  secondary={<Button variant="secondary" leadingIcon={<Repeat size={16} aria-hidden />} onClick={openTemplates}>Recorrentes</Button>}
  primary={<Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>Nova despesa</Button>}
/>
```

Remove the now-redundant `.expenses-header-actions` layout rules and their
responsive button override from `ExpensesModule.css`. Retain unrelated Expenses
layout and data presentation rules.

For Investments, pass the existing month `Field` through `context` and the
existing `Novo investimento` Button through `primary`. Preserve the
`showAllMonths` disabling condition.

- [ ] **Step 5: Migrate utility-only and context-heavy headers**

For Audit, put `Atualizar` in `secondary` and give it the existing loading
state and callback.

For Reports:

- pass the report view button set through `context`;
- keep view buttons `ghost` and `sm` because they are a segmented navigation
  control, not header commands;
- pass `Exportar CSV` through `secondary`;
- keep the current disabled expression and callback.

For Profit:

- pass month and all-months controls through `context`;
- pass PDF and Excel export buttons through `secondary`;
- preserve download formats, busy state and titles.

- [ ] **Step 6: Correct the nested monthly preview’s hierarchy**

`MonthlyBillingPreview` uses `.module-header` and will no longer inherit the
legacy primary override. Make `Confirmar e gerar` explicitly `primary` and
keep `Cancelar` explicitly `secondary`. Do not otherwise redesign the preview
or dialog content.

- [ ] **Step 7: Run renderer mapping, component and type checks**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/ModuleHeaderActionMapping.test.tsx src/renderer/components/Button.test.tsx src/renderer/components/ModuleHeaderActions.test.tsx src/renderer/components/ModuleHeaderActions.styles.test.ts
npx.cmd tsc --noEmit
npm.cmd run lint
```

Expected: PASS.

- [ ] **Step 8: Commit the propagation**

```powershell
git add src/renderer/modules/ModuleHeaderActionMapping.test.tsx src/renderer/modules/PlansModule.tsx src/renderer/modules/StockModule.tsx src/renderer/modules/UsersModule.tsx src/renderer/modules/WorkOrdersModule.tsx src/renderer/modules/ExpensesModule.tsx src/renderer/modules/ExpensesModule.css src/renderer/modules/InvestmentsModule.tsx src/renderer/modules/AuditModule.tsx src/renderer/modules/ReportsModule.tsx src/renderer/modules/ProfitModule.tsx src/renderer/modules/payments/MonthlyBillingPreview.tsx
git commit -m "feat: propagate semantic actions across module headers"
```

---

### Task 6: Validate interaction, themes and release quality

**Files:**
- Modify if visual tuning is required: `src/renderer/styles.css`
- Modify if a regression is found: the smallest owning component or module
- Evidence only: `C:\tmp\ispm-*-header-actions.png`

**Interfaces:**
- Consumes: the complete action system from Tasks 1–5.
- Produces: verified visual evidence and a clean test/type/lint result.

- [ ] **Step 1: Run the complete automated quality gate**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json --noEmit
npm.cmd run lint
git diff --check
```

Expected: all tests pass, both TypeScript projects pass, lint passes and
`git diff --check` emits no errors.

- [ ] **Step 2: Audit dark mode at the reference viewport**

Using the local Vite server at `http://127.0.0.1:5173`, mock auth as bypassed
and return isolated fixture data. Capture 1440 × 900 screenshots for:

- Clients: secondary `Importar` versus primary `Novo cliente`;
- Services: secondary `Atribuir IPs` versus primary `Novo servico`;
- Payments: month context, two secondary notifications, critical reversal and
  primary generation.

Save:

```text
C:\tmp\ispm-clientes-dark-header-actions.png
C:\tmp\ispm-servicos-dark-header-actions.png
C:\tmp\ispm-pagamentos-dark-header-actions.png
```

Inspect computed styles and verify different backgrounds/borders between
secondary, critical and primary variants.

- [ ] **Step 3: Audit light mode and constrained width**

Capture Clients and Payments in light mode at 1440 × 900 and Payments at
1024 × 768:

```text
C:\tmp\ispm-clientes-light-header-actions.png
C:\tmp\ispm-pagamentos-light-header-actions.png
C:\tmp\ispm-pagamentos-narrow-header-actions.png
```

Verify:

- blue primary identity in light mode;
- no brown primary header action;
- no clipping or horizontal overflow;
- context and command groups wrap predictably;
- primary remains the strongest terminal action.

- [ ] **Step 4: Audit keyboard, state and motion behaviour**

In the browser:

1. Tab through secondary, critical and primary actions and verify a visible
   two-layer focus distinction.
2. Trigger a safe mocked loading state and confirm label width remains stable.
3. Inspect disabled Payments actions and confirm no lift/brightening on hover.
4. Emulate `prefers-reduced-motion: reduce` and confirm hover/press transforms
   are removed.
5. Verify each command group has a meaningful accessible name and all visible
   text icons are hidden from the accessibility tree.

- [ ] **Step 5: Tune only against explicit failures**

If a visual/accessibility check fails, change only the owning token or layout
rule, rerun the focused component/style tests, and recapture the affected
screenshot. Do not introduce module-specific colour overrides.

- [ ] **Step 6: Commit verified visual tuning if needed**

```powershell
git add src/renderer/styles.css
git commit -m "style: tune verified header action states"
```

Skip this commit when browser validation requires no source change.

- [ ] **Step 7: Record final repository state**

Run:

```powershell
git status --short
git log -6 --oneline
```

Expected: no unintended uncommitted files and the action-system commits are
present in logical order.

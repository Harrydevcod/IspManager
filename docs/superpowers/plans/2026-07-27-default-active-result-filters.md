# Default Active Result Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open Clientes and Serviços with `Ativos`, and Pagamentos with `Pendente`, while preserving every manual filter option.

**Architecture:** Keep the API and database contracts unchanged and set named default filter constants inside the three renderer modules. Use each constant for both React state initialization and `Limpar filtros`; explicit navigation filters continue to override the defaults.

**Tech Stack:** React 19, TypeScript 5.7, Vitest 2, jsdom, React DOM.

## Global Constraints

- Clientes defaults to `active`.
- Serviços defaults to `active`.
- Pagamentos defaults to `pending`.
- Every existing status option, including `all`, remains manually selectable.
- `Limpar filtros` restores the module-specific default and continues resetting the other existing filters.
- Explicit navigation to a client or payment status continues to override the module default.
- No API, database, migration, or persisted-preference change.

---

## File Structure

- Create `src/renderer/modules/OperationalDefaultFilters.test.tsx`: browser-like component tests for initial state, manual options, and reset behavior in all three modules.
- Modify `src/renderer/modules/ClientsModule.tsx`: define and use the Clientes status default.
- Modify `src/renderer/modules/ServicesModule.tsx`: define and use the Serviços status default while retaining the explicit client-focus override.
- Modify `src/renderer/modules/PaymentsModule.tsx`: define and use the Pagamentos status default while retaining dashboard focus overrides.
- Modify `package.json` and `package-lock.json`: add jsdom as a development-only Vitest environment.

### Task 1: Operational list defaults

**Files:**
- Create: `src/renderer/modules/OperationalDefaultFilters.test.tsx`
- Modify: `src/renderer/modules/ClientsModule.tsx`
- Modify: `src/renderer/modules/ServicesModule.tsx`
- Modify: `src/renderer/modules/PaymentsModule.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ClientsModule`, `ServicesModule`, `PaymentsModule`, `AuthProvider`, the existing `Estado` selects, and the existing `Limpar filtros` buttons.
- Produces: no new cross-module API; each module gains a private typed `DEFAULT_*_STATUS_FILTER` constant.

- [ ] **Step 1: Add the browser-like test environment**

Run:

```powershell
npm.cmd install --save-dev jsdom
```

Expected: `jsdom` is present under `devDependencies`, and the lockfile records its exact resolved dependency graph.

- [ ] **Step 2: Write the failing component tests**

Create `src/renderer/modules/OperationalDefaultFilters.test.tsx`:

```tsx
/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';
import { PaymentsModule } from './PaymentsModule';
import { ServicesModule } from './ServicesModule';

type ModuleCase = {
  name: string;
  render: () => ReactElement;
  defaultStatus: string;
  statuses: string[];
};

const modules: ModuleCase[] = [
  {
    name: 'Clientes',
    render: () => <ClientsModule />,
    defaultStatus: 'active',
    statuses: ['all', 'active', 'suspended', 'cancelled']
  },
  {
    name: 'Serviços',
    render: () => <ServicesModule />,
    defaultStatus: 'active',
    statuses: ['all', 'active', 'suspended', 'cancelled']
  },
  {
    name: 'Pagamentos',
    render: () => <PaymentsModule />,
    defaultStatus: 'pending',
    statuses: ['all', 'pending', 'overdue', 'paid', 'cancelled']
  }
];

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
    root.render(<AuthProvider>{element}</AuthProvider>);
  });

  return container;
}

function statusSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(
    (candidate) => candidate.closest('label')?.querySelector('.field-label')?.textContent === 'Estado'
  );
  if (!select) throw new Error('Estado select not found');
  return select;
}

function clearFiltersButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Limpar filtros'
  );
  if (!button) throw new Error('Limpar filtros button not found');
  return button;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return jsonResponse({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/audiovisual-config')) {
      return jsonResponse(null);
    }
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

describe.each(modules)('$name operational status filter', ({ render, defaultStatus, statuses }) => {
  test(`opens with ${defaultStatus} selected`, async () => {
    const select = statusSelect(await mount(render()));
    expect(select.value).toBe(defaultStatus);
  });

  test('keeps every status manually available', async () => {
    const select = statusSelect(await mount(render()));
    expect([...select.options].map((option) => option.value)).toEqual(statuses);
  });

  test(`restores ${defaultStatus} when filters are cleared`, async () => {
    const container = await mount(render());
    const select = statusSelect(container);

    await act(async () => {
      select.value = 'all';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('all');

    await act(async () => {
      clearFiltersButton(container).click();
    });
    expect(select.value).toBe(defaultStatus);
  });
});

test('an explicit payment focus overrides the pending default', async () => {
  const select = statusSelect(await mount(<PaymentsModule focusStatus="overdue" />));
  expect(select.value).toBe('overdue');
});
```

Production breaks caught:

- Reverting a module initializer to `all` fails its initial-state test.
- Removing or renaming a manual option fails its exact ordered-options test.
- Resetting a module to `all` fails its clear-filters test.
- Ignoring an explicit dashboard payment focus fails the override test.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/OperationalDefaultFilters.test.tsx
```

Expected: the manual-options assertions pass, while initial-state and clear-filters assertions fail because all three modules currently resolve to `all`.

- [ ] **Step 4: Implement the Clientes default**

In `src/renderer/modules/ClientsModule.tsx`, add beside the existing sort and page-size defaults:

```ts
const DEFAULT_CLIENT_STATUS_FILTER: 'all' | Client['status'] = 'active';
```

Use it in both places:

```ts
const [statusFilter, setStatusFilter] = useState<'all' | Client['status']>(
  DEFAULT_CLIENT_STATUS_FILTER
);
```

```ts
setStatusFilter(DEFAULT_CLIENT_STATUS_FILTER);
```

- [ ] **Step 5: Implement the Serviços default**

In `src/renderer/modules/ServicesModule.tsx`, add before `ServicesModule`:

```ts
const DEFAULT_SERVICE_STATUS_FILTER: 'all' | ServiceRow['status'] = 'active';
```

Use it for state initialization and `Limpar filtros`:

```ts
const [statusFilter, setStatusFilter] = useState<'all' | ServiceRow['status']>(
  DEFAULT_SERVICE_STATUS_FILTER
);
```

```ts
setStatusFilter(DEFAULT_SERVICE_STATUS_FILTER);
```

Keep the existing `setStatusFilter('all')` inside the `focusClientId` effect. That is an explicit navigation override required to expose every service belonging to the selected client.

- [ ] **Step 6: Implement the Pagamentos default**

In `src/renderer/modules/PaymentsModule.tsx`, add beside the existing sort and page-size defaults:

```ts
const DEFAULT_PAYMENT_STATUS_FILTER: 'all' | PaymentRow['status'] = 'pending';
```

Use it for state initialization and `Limpar filtros`:

```ts
const [statusFilter, setStatusFilter] = useState<'all' | PaymentRow['status']>(
  DEFAULT_PAYMENT_STATUS_FILTER
);
```

```ts
setStatusFilter(DEFAULT_PAYMENT_STATUS_FILTER);
```

Keep the existing `focusStatus` effect unchanged so dashboard navigation to `overdue` or `pending` remains authoritative.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/OperationalDefaultFilters.test.tsx
```

Expected: 10 tests pass with no warnings or unhandled React updates.

- [ ] **Step 8: Run the complete validation baseline**

Run:

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
```

Expected: every command exits with code 0 and no new warnings.

- [ ] **Step 9: Review the final diff**

Run:

```powershell
git diff --check
git diff -- src/renderer/modules/OperationalDefaultFilters.test.tsx src/renderer/modules/ClientsModule.tsx src/renderer/modules/ServicesModule.tsx src/renderer/modules/PaymentsModule.tsx package.json package-lock.json
```

Expected: only the test dependency, the new behavior tests, and the six intended initializer/reset substitutions appear.

- [ ] **Step 10: Commit the tested implementation**

```powershell
git add package.json package-lock.json src/renderer/modules/OperationalDefaultFilters.test.tsx src/renderer/modules/ClientsModule.tsx src/renderer/modules/ServicesModule.tsx src/renderer/modules/PaymentsModule.tsx
git commit -m "feat(filters): default operational lists to active states"
```

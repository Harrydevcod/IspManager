# SMS Report Card Visual Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the monthly SMS delivery report card with stronger editorial hierarchy, balanced status indicators, and component-responsive layout without changing content or behavior.

**Architecture:** Keep `SmsTab` markup, props, and monthly-report data flow unchanged. Replace only the report's existing CSS block and add a focused source-level CSS contract test so the visual layout requirements remain protected without adding a browser-test dependency.

**Tech Stack:** React 19, TypeScript 5.7, CSS container queries, Vitest 2.1, ESLint 10.

## Global Constraints

- Preserve the report section, **Canal SMS** eyebrow, **Relatório de entrega de SMS** heading, native month selector, five delivery states, state order, loading behavior, and accessibility semantics.
- Do not change renderer props, report queries, counts, status labels, semantic tone assignments, error handling, or Android companion connectivity.
- Use CSS container queries on `.sms-delivery-report`; do not add JavaScript for layout.
- Keep semantic color on numeric values only and retain a visible text label for every status.
- Do not add dependencies, shadows, gradients, decorative icons, or animation.

---

### Task 1: Refine the monthly SMS report card

**Files:**

- Create: `src/renderer/modules/settings/SmsTab.styles.test.ts`
- Modify: `src/renderer/styles.css:5195-5290`
- Verify: `src/renderer/modules/settings/SmsTab.test.tsx`

**Interfaces:**

- Consumes: the existing `.sms-delivery-report`, `.sms-delivery-report-head`, `.sms-report-month`, `.sms-report-loading`, `.sms-queue`, `.sms-queue-stat`, `.sms-queue-stat-value`, and `.sms-queue-stat-label` class names emitted by `SmsTab`.
- Produces: a CSS-only responsive report layout; no React component API, DOM order, accessible name, or data-flow change.

- [ ] **Step 1: Add a failing CSS layout contract test**

Create `src/renderer/modules/settings/SmsTab.styles.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

function declarations(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  return match?.[1] ?? '';
}

describe('SMS report card styles', () => {
  test('uses a balanced component-responsive layout', () => {
    expect(declarations('.sms-delivery-report')).toMatch(
      /container-type:\s*inline-size/
    );
    expect(declarations('.sms-delivery-report-head')).toMatch(
      /justify-content:\s*space-between/
    );
    expect(declarations('.sms-queue')).toMatch(/display:\s*grid/);
    expect(declarations('.sms-queue')).toMatch(
      /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(styles).toContain('@container (max-width: 32rem)');
    expect(styles).toContain('@container (max-width: 22rem)');
  });

  test('keeps hierarchy and semantic color restrained', () => {
    expect(declarations('.sms-delivery-report h3')).toMatch(
      /color:\s*var\(--text\)/
    );
    expect(declarations('.sms-queue-stat-value')).toMatch(
      /font-size:\s*var\(--fs-xl\)/
    );
    expect(declarations('.sms-queue-stat-label')).toMatch(
      /font-weight:\s*600/
    );
    expect(styles).toContain(
      ".sms-queue-stat[data-tone='success'] .sms-queue-stat-value"
    );
    expect(styles).toContain(
      ".sms-queue-stat[data-tone='danger'] .sms-queue-stat-value"
    );
  });
});
```

- [ ] **Step 2: Run the focused style test and verify the contract fails**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.styles.test.ts
```

Expected: FAIL because `.sms-delivery-report` does not yet declare `container-type: inline-size`, the header does not use `space-between`, and `.sms-queue` is still flex-based.

- [ ] **Step 3: Replace the existing SMS report CSS block**

In `src/renderer/styles.css`, replace the rules from `.sms-delivery-report` through `.sms-queue-stat-label` with:

```css
/* Relatório SMS: superfície editorial compacta. O cabeçalho e os estados
   respondem à largura do próprio painel, não à viewport da aplicação. */
.sms-delivery-report {
  container-type: inline-size;
  display: grid;
  gap: 0;
  margin: var(--space-2) 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--r2);
  background: color-mix(in oklch, var(--surface-2) 58%, var(--surface));
}

.sms-delivery-report-head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--space-3) var(--space-6);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
}

.sms-delivery-report-head > div:first-child {
  display: grid;
  gap: var(--space-0-5);
  min-width: 0;
}

.sms-delivery-report-eyebrow {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sms-delivery-report h3 {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: var(--tracking-tight);
  line-height: 1.2;
}

.sms-report-month {
  flex: 0 0 10.5rem;
  width: min(10.5rem, 100%);
  margin-inline: 0;
}

.sms-report-loading {
  display: flex;
  align-items: center;
  min-height: 4.5rem;
  padding: var(--space-3) var(--space-4);
  color: var(--text-3);
  font-size: var(--fs-sm);
}

.sms-queue {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  background: var(--border);
}

.sms-queue-stat {
  display: grid;
  align-content: center;
  gap: var(--space-1);
  min-width: 0;
  min-height: 4.5rem;
  padding: var(--space-3) var(--space-4);
  background: color-mix(in oklch, var(--surface-2) 58%, var(--surface));
}

.sms-queue-stat-value {
  color: var(--text-2);
  font-family: var(--font-display);
  font-size: var(--fs-xl);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--tracking-tight);
  line-height: 1;
}

.sms-queue-stat[data-tone='warn'] .sms-queue-stat-value { color: var(--warn); }
.sms-queue-stat[data-tone='success'] .sms-queue-stat-value { color: var(--success); }
.sms-queue-stat[data-tone='danger'] .sms-queue-stat-value { color: var(--danger); }

.sms-queue-stat-label {
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.2;
  text-transform: uppercase;
}

@container (max-width: 32rem) {
  .sms-delivery-report-head {
    align-items: stretch;
  }

  .sms-report-month {
    flex-basis: 100%;
    width: 100%;
  }

  .sms-queue {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .sms-queue-stat {
    grid-column: span 2;
  }

  .sms-queue-stat:nth-last-child(-n + 2) {
    grid-column: span 3;
  }
}

@container (max-width: 22rem) {
  .sms-queue {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sms-queue-stat,
  .sms-queue-stat:nth-last-child(-n + 2) {
    grid-column: auto;
  }

  .sms-queue-stat:last-child {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 4: Run focused tests and verify the CSS contract and renderer behavior pass**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.styles.test.ts src/renderer/modules/settings/SmsTab.test.tsx
```

Expected: two style-contract tests and all five existing renderer tests PASS. The renderer markup, month callback, zero values, loading state, and stale-response guard remain unchanged.

- [ ] **Step 5: Run repository validation**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
git diff --check
```

Expected: every command exits with code 0; the complete Vitest suite passes; no whitespace errors are reported.

- [ ] **Step 6: Review the focused diff**

Run:

```powershell
git diff -- src/renderer/styles.css src/renderer/modules/settings/SmsTab.styles.test.ts
git status --short
```

Expected: only the SMS report CSS block and its focused test differ from `HEAD`; no React, backend, documentation, or unrelated style rules changed.

- [ ] **Step 7: Commit the implementation**

Run:

```powershell
git add src/renderer/styles.css src/renderer/modules/settings/SmsTab.styles.test.ts
git commit -m "style(sms): refine monthly report card"
```

Expected: one implementation commit containing only the CSS refinement and its focused regression test.

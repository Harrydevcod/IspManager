# SMS report compact header implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place the monthly selector directly beside the SMS report title and
compact the bordered report panel around its content.

**Architecture:** Keep the existing React markup and monthly-report data flow.
Change only the four spacing declarations that create excess whitespace in the
report panel and remove the selector's automatic inline margin.

**Tech stack:** CSS, React renderer tests, TypeScript, and ESLint.

## Global constraints

- Preserve the report border, background, radius, markup, and behavior.
- Keep the title block and selector adjacent at desktop widths.
- Keep flex wrapping for narrow widths.
- Do not change the selector width or spacing inside the five indicators.
- Do not stage `src/renderer/styles.css`; it contains preexisting user work.

---

### Task 1: Compact the monthly report panel

**Files:**

- Modify: `src/renderer/styles.css:5198`
- Test: `src/renderer/modules/settings/SmsTab.test.tsx`

**Interfaces:**

- Consumes: the existing `.sms-delivery-report`,
  `.sms-delivery-report-head`, and `.sms-report-month` markup classes.
- Produces: a compact, responsive visual arrangement with no component API
  changes.

- [ ] **Step 1: Confirm the current spacing baseline**

Run:

```powershell
Select-String -Path src\renderer\styles.css -Pattern '^\.sms-delivery-report|^\.sms-report-month' -Context 0,12
```

Expected: the panel uses `gap` and `padding` at `var(--space-3)` or above, and
`.sms-report-month` uses `margin-inline: auto`.

- [ ] **Step 2: Apply the minimal CSS change**

Update the three existing rules to exactly:

```css
.sms-delivery-report {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--r2);
  background: color-mix(in oklch, var(--surface-2) 55%, transparent);
}

.sms-delivery-report-head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: flex-start;
  gap: var(--space-2) var(--space-4);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.sms-report-month {
  width: min(11rem, 100%);
  margin-inline: 0;
}
```

- [ ] **Step 3: Verify semantics and static quality**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.test.tsx
npm.cmd run typecheck
npm.cmd run lint
git diff --check -- src/renderer/styles.css
```

Expected: five renderer tests pass, typecheck and lint report no errors, and Git
reports no whitespace errors.

- [ ] **Step 4: Review the focused CSS diff without staging**

Run:

```powershell
git diff -- src/renderer/styles.css
```

Expected: among the preserved preexisting style changes, the compact-panel edit
changes only the report gap, margin, padding, header padding, and selector
margin. Do not run `git add`.

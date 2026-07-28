# Light Graphite Primary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blue primary action buttons with editorial graphite in the light theme while preserving the existing blue treatment in dark mode.

**Architecture:** Keep the theme-specific decision inside the existing `--action-primary-*` token family so `Button`, `ModuleHeaderActions` and every module remain unchanged. Override only the light-theme primary surface, foreground, border, shadow and focus tokens, then validate the running renderer in both themes.

**Tech Stack:** CSS/OKLCH design tokens, React 19 shared Button primitive, Vitest 2, Playwright visual audit, Vite HMR.

## Global Constraints

- Light-theme primary actions use editorial graphite, not blue or brown.
- Dark-theme primary actions keep the existing ISPM blue/cyan treatment.
- Secondary actions remain cool-neutral and critical actions remain cool-neutral with red cues.
- Foreground, border, shadow, hover, active and focus states preserve WCAG AA contrast and the graphite identity.
- Preserve every permission check, callback, confirmation flow, responsive layout and domain operation.
- Do not modify module components or add dependencies.
- Design specification: `docs/superpowers/specs/2026-07-27-module-header-actions-design.md`.

---

### Task 1: Establish the light graphite primary contract

**Files:**
- Modify: `src/renderer/components/ModuleHeaderActions.styles.test.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: existing `--action-primary-start`, `--action-primary-end`, `--action-primary-fg`, `--action-primary-border`, `--action-primary-shadow`, `--action-primary-shadow-hover` and `--action-focus` tokens.
- Produces: graphite light-theme values for the same token interface; no component API changes.

- [ ] **Step 1: Write the failing theme contract test**

Add this test to `src/renderer/components/ModuleHeaderActions.styles.test.ts`:

```ts
test('uses editorial graphite for light primary actions while dark stays blue', () => {
  const lightTheme = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

  expect(css).toContain('--action-primary-start: oklch(72% 0.15 246);');
  expect(css).toContain('--action-primary-end: oklch(62% 0.18 258);');
  expect(lightTheme).toContain('--action-primary-start: oklch(40% 0.02 255);');
  expect(lightTheme).toContain('--action-primary-end: oklch(27% 0.016 255);');
  expect(lightTheme).toContain('--action-primary-fg: oklch(99% 0.003 255);');
  expect(lightTheme).toContain('--action-primary-border: oklch(22% 0.014 255);');
  expect(lightTheme).toContain('--action-focus: oklch(36% 0.03 255 / 0.42);');
  expect(lightTheme).not.toContain('--action-primary-start: oklch(60% 0.18 249);');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.styles.test.ts
```

Expected: FAIL because the light theme still defines a blue `249–260` primary gradient.

- [ ] **Step 3: Implement the graphite light-theme tokens**

In `:root[data-theme="light"]` inside `src/renderer/styles.css`, replace only the light primary tokens with:

```css
--action-primary-start: oklch(40% 0.02 255);
--action-primary-end: oklch(27% 0.016 255);
--action-primary-fg: oklch(99% 0.003 255);
--action-primary-border: oklch(22% 0.014 255);
--action-primary-shadow:
  0 1px 0 oklch(100% 0 0 / 0.2) inset,
  0 10px 22px -14px oklch(20% 0.02 255 / 0.56);
--action-primary-shadow-hover:
  0 1px 0 oklch(100% 0 0 / 0.26) inset,
  0 14px 28px -15px oklch(18% 0.024 255 / 0.64);
```

Replace the light `--action-focus` override with:

```css
--action-focus: oklch(36% 0.03 255 / 0.42);
```

Do not alter the root dark primary tokens or any module JSX.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.styles.test.ts src/renderer/components/Button.test.tsx
npm.cmd run typecheck
```

Expected: all focused tests and TypeScript PASS.

- [ ] **Step 5: Commit the light-theme primary correction**

```powershell
git add src/renderer/components/ModuleHeaderActions.styles.test.ts src/renderer/styles.css
git commit -m "style: use graphite primary actions in light mode"
```

---

### Task 2: Validate the running app and update PR #81

**Files:**
- Inspect: rendered Clientes, Serviços and Pagamentos module headers
- Inspect: `src/renderer/styles.css`

**Interfaces:**
- Consumes: graphite primary tokens from Task 1 and the renderer already running on `http://127.0.0.1:5173`.
- Produces: browser evidence, a green validation gate and an updated PR #81.

- [ ] **Step 1: Audit the active renderer with mocked API data**

Run the existing Playwright header-action audit against port `5173`. Capture:

- Clientes, Serviços and Pagamentos in dark mode at 1440 × 900;
- Clientes and Pagamentos in light mode at 1440 × 900;
- Pagamentos in light mode at 1024 × 768;
- keyboard focus and reduced-motion states.

Expected:

- dark primary computed styles remain blue/cyan;
- light primary computed styles use hue `255`, low chroma and a graphite lightness range;
- light primaries contain no blue or brown treatment;
- secondary and critical treatments are unchanged;
- one primary per header, no page errors and no horizontal overflow.

- [ ] **Step 2: Run the complete validation gate**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd tsc -p tsconfig.main.json --noEmit
npm.cmd run lint
npx.cmd vite build
git diff --check
git status --short
```

Expected: 55 or more test files pass, both TypeScript checks pass, lint and production renderer build pass, diff check is clean and the worktree has no uncommitted changes.

- [ ] **Step 3: Publish and confirm the PR**

Run:

```powershell
git push
gh pr view 81 --json url,isDraft,state,baseRefName,headRefName,mergeable,mergeStateStatus
```

Expected: PR #81 remains an open draft from `feat/module-header-actions` into `feat/device-ip-visibility`, with a clean merge state.


# Cool-Neutral Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every brown, beige and cream treatment from module-header action buttons while preserving the approved semantic hierarchy.

**Architecture:** Keep the correction inside the existing action-specific CSS tokens so header composition and module code remain unchanged. Define explicit cool-neutral surface, border, foreground and shadow tokens for both themes, then make secondary and critical Button states consume only those semantic tokens.

**Tech Stack:** CSS/OKLCH design tokens, React 19 shared Button primitive, Vitest 2, Playwright visual audit.

## Global Constraints

- Scope remains limited to module-header actions and the shared `Button` primitive.
- Secondary action colours must be independent from the light theme's warm editorial surface and text tokens.
- Cool-neutral action tokens use a restrained 250–260 hue and very low chroma.
- Primary actions remain in the ISPM blue/cyan family.
- Critical actions use a cool-neutral resting surface with red foreground and interaction cues.
- No header action surface, border, foreground or shadow may use a brown, beige, cream or orange treatment.
- Preserve permissions, callbacks, confirmation flows, responsive layout and accessible states.
- Do not add dependencies or modify domain behaviour.
- Design specification: `docs/superpowers/specs/2026-07-27-module-header-actions-design.md`.

---

### Task 1: Establish the cool-neutral Button palette

**Files:**
- Modify: `src/renderer/components/ModuleHeaderActions.styles.test.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: existing CSS variables `--action-secondary-bg`, `--action-secondary-hover`, `--action-secondary-border` and `--action-secondary-border-hover`.
- Produces: new semantic variables `--action-secondary-fg` and `--action-secondary-shadow`, plus explicit cool-neutral values for all secondary action tokens in dark and light themes.

- [ ] **Step 1: Write the failing palette contract test**

Add this test to `src/renderer/components/ModuleHeaderActions.styles.test.ts`:

```ts
test('keeps header action surfaces and text cool-neutral instead of warm brown', () => {
  expect(css).toContain('--action-secondary-fg: oklch(93% 0.006 251);');
  expect(css).toContain('--action-secondary-shadow:');
  expect(css).toContain('--action-secondary-bg: oklch(98.7% 0.003 255);');
  expect(css).toContain('--action-secondary-hover: oklch(96.2% 0.006 255);');
  expect(css).toContain('--action-secondary-border: oklch(82% 0.012 255);');
  expect(css).toContain('--action-secondary-border-hover: oklch(69% 0.018 255);');
  expect(css).toContain('--action-secondary-fg: oklch(28% 0.015 255);');
  expect(css).toMatch(/\.btn-secondary\s*\{[^}]*color:\s*var\(--action-secondary-fg\);/);
  expect(css).toMatch(/\.btn-secondary:hover:not\(:disabled\)\s*\{[^}]*box-shadow:\s*var\(--action-secondary-shadow\);/);
  expect(css).toMatch(/\.btn-critical:hover:not\(:disabled\),[\s\S]*?background:\s*color-mix\(in oklch, var\(--danger-bg\) 72%, var\(--action-secondary-hover\)\);/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.styles.test.ts
```

Expected: FAIL because `--action-secondary-fg`, `--action-secondary-shadow` and the explicit light cool-neutral values do not exist.

- [ ] **Step 3: Implement explicit cool-neutral action tokens**

In the root action hierarchy token block in `src/renderer/styles.css`, replace the secondary token definitions with:

```css
--action-secondary-bg: oklch(28.5% 0.012 251 / 0.88);
--action-secondary-hover: oklch(32.5% 0.016 251);
--action-secondary-border: oklch(45% 0.016 251 / 0.72);
--action-secondary-border-hover: oklch(55% 0.018 251 / 0.9);
--action-secondary-fg: oklch(93% 0.006 251);
--action-secondary-shadow:
  0 8px 18px -14px oklch(24% 0.02 255 / 0.5);
```

In the light-theme action hierarchy token block, replace the secondary token definitions with:

```css
--action-secondary-bg: oklch(98.7% 0.003 255);
--action-secondary-hover: oklch(96.2% 0.006 255);
--action-secondary-border: oklch(82% 0.012 255);
--action-secondary-border-hover: oklch(69% 0.018 255);
--action-secondary-fg: oklch(28% 0.015 255);
--action-secondary-shadow:
  0 8px 18px -14px oklch(42% 0.04 255 / 0.22);
```

Update the Button variant styles:

```css
.btn-secondary {
  border-color: var(--action-secondary-border);
  background: var(--action-secondary-bg);
  color: var(--action-secondary-fg);
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--action-secondary-border-hover);
  background: var(--action-secondary-hover);
  box-shadow: var(--action-secondary-shadow);
}

.btn-critical:hover:not(:disabled),
.btn-critical:focus-visible {
  border-color: color-mix(in oklch, var(--danger) 58%, var(--action-secondary-border));
  background: color-mix(in oklch, var(--danger-bg) 72%, var(--action-secondary-hover));
  box-shadow: 0 8px 18px -14px color-mix(in oklch, var(--danger) 62%, transparent);
}
```

Do not alter the primary blue tokens or module components.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```powershell
npx.cmd vitest run src/renderer/components/ModuleHeaderActions.styles.test.ts src/renderer/components/Button.test.tsx
npm.cmd run typecheck
```

Expected: all focused tests and TypeScript PASS.

- [ ] **Step 5: Commit the palette correction**

```powershell
git add src/renderer/components/ModuleHeaderActions.styles.test.ts src/renderer/styles.css
git commit -m "style: remove warm tones from header actions"
```

---

### Task 2: Validate the palette and update PR #81

**Files:**
- Inspect: `src/renderer/styles.css`
- Inspect: rendered Clientes, Serviços and Pagamentos module headers

**Interfaces:**
- Consumes: the cool-neutral action tokens from Task 1.
- Produces: browser evidence and a fully validated branch published to PR #81.

- [ ] **Step 1: Audit the rendered colour system**

Run the existing Playwright header-action audit against the isolated Vite renderer with mocked API responses. Capture:

- Clientes, Serviços and Pagamentos in dark mode at 1440 × 900;
- Clientes and Pagamentos in light mode at 1440 × 900;
- Pagamentos in light mode at 1024 × 768;
- keyboard focus and reduced-motion states.

Inspect computed styles and screenshots. Expected:

- secondary buttons are visibly cool grey, never beige or brown;
- primary buttons remain blue in both themes;
- critical buttons rest on the cool-neutral surface with red foreground;
- each header has at most one primary action;
- no page errors or horizontal overflow.

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

Expected: 55 or more test files pass, both TypeScript checks pass, lint passes, the renderer production build succeeds, diff check is clean and the worktree has no uncommitted changes.

- [ ] **Step 3: Publish and confirm the PR**

Run:

```powershell
git push
gh pr view 81 --json url,isDraft,state,baseRefName,headRefName,mergeable,mergeStateStatus
```

Expected: PR #81 remains an open draft from `feat/module-header-actions` into `feat/device-ip-visibility`, with a clean merge state.


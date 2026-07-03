# DESIGN.md — ISPM design system

Stack: Electron + React 19 + Vite + TypeScript. No CSS framework. Hand-rolled `src/renderer/styles.css` with OKLCH tokens + colocated module CSS files.

Single source: `src/renderer/styles.css`. Full audit: `.design-audit/PRIMITIVES-AUDIT.md`.

## Theme

Dark-first. Light theme is genuine (editorial warm off-white, NOT inverted dark). Theme toggle persists to localStorage; FOUC-prevention bootstrap in `index.html` (only place hex literals are allowed).

Scene that forces dark default: *the owner reconciles monthly payments at 22:30 on a 24" monitor in a dim home office, switching between the invoice PDF preview and the Pagamentos table.*

## Color

**OKLCH only.** One hex literal allowed in the entire codebase (the FOUC bootstrap). 1518+ `var(--*)` references.

**Strategy:** Restrained. Warm-tinted neutrals (hue 72) + one heritage-gold accent at ≤10% coverage. Semantic colors are paired surface tints for dark legibility.

```
--bg: oklch(21.5% 0.01 251)       /* grafite frio — NÃO near-black (feedback do dono, 2026-07-03) */
--surface: oklch(25% 0.011 251)
--surface-2: oklch(28.5% 0.012 251)
--surface-3: oklch(32.5% 0.013 249)
--border: oklch(35.5% 0.014 249)  /* hairline */
--border-2: oklch(45% 0.016 247)

--text: oklch(93% 0.006 251)
--text-2: oklch(74% 0.01 251)
--text-3: oklch(62% 0.012 251)    /* muted captions */

--accent: oklch(68% 0.15 251)     /* azul Windows do dono (#0078D4 elevado p/ dark) */
--accent-2: oklch(61% 0.16 251)
--on-accent: oklch(16% 0.02 251)

--success: oklch(77% 0.16 148) + --success-bg: oklch(29% 0.07 148)
--danger:  oklch(70% 0.18 24)  + --danger-bg:  oklch(29% 0.075 24)
--info:    oklch(72% 0.12 212) + --info-bg:   oklch(29% 0.045 212)
```

O accent dark é o **accent do Windows do dono** (#0078D4, capturado do registry `HKCU\...\DWM\AccentColor` em 2026-07-03) — pedido explícito; o tema claro mantém o dourado heritage.

**Acrílico (2026-07-03, pedido do dono):** a janela Electron usa `backgroundMaterial: 'acrylic'` + `backgroundColor: '#00000000'`; o `:root` em dark pinta um véu `color-mix(var(--bg) 82%, transparent)` e o `body` é transparente (o material aparece através). A sidebar leva translucidez extra (mix 90%). O tema claro fica opaco (`background: var(--bg)` no bloco light). O bootstrap FOUC usa `#161A1ED1` (dark, com alpha) e `applyThemePref` limpa o inline ao trocar de tema — não remover essa limpeza. Meta theme-color dark: `#161A1E`. Exceção consciente ao ban de glassmorphism: é material do SO, não blur decorativo em cards.

Light theme: `--bg: oklch(96.5% 0.005 72)`, `--accent: oklch(48% 0.135 65)` (darker gold for AA contrast).

## Typography

**Inter Variable**, single family (`@fontsource-variable/inter`). Both `--font-ui` and `--font-display` point to it. Hierarchy through weight + tracking contrast.

```
--fs-xs:   0.6875rem    11px  uppercase caps for labels
--fs-sm:   0.8125rem    13px  body small
--fs-base: 0.9375rem    15px  body
--fs-lg:   1.0625rem    17px  card titles
--fs-xl:   1.375rem     22px  section heads
--fs-2xl:  clamp(1.9rem, 1.4rem + 1.8vw, 2.6rem)  display

--tracking-tight:   -0.018em   /* h1/h2/h3 */
--tracking-tighter: -0.024em   /* display-xl */
```

Feature-set: `cv11, ss01, ss03, calt, kern` global; `+ tnum` on every numeric column (metrics, payment rows, money amounts, data lists, table cells).

Body weight 380. Headings 600. Caps labels 700 with `letter-spacing: 0.06em; text-transform: uppercase` (the `.field-label` / `.filter-bar label` pattern).

## Spacing scale

```
--s1: 4px    --s2: 8px    --s3: 12px    --s4: 16px
--s5: 24px   --s6: 32px   --s7: 48px
```

Rhythm rule: not the same spacing everywhere. Module headers use s5/s6, filter rows s3, table cells s2/s3, primitive internal gaps s1/s2.

## Radius / elevation

```
--r1: 7px    --r2: 11px    --r3: 16px    --rpill: 999px
--shadow-1: 0 1px 2px oklch(0% 0 0 / 0.45)
--shadow-2: 0 14px 36px -14px oklch(0% 0 0 / 0.65)
```

Depth in dark mode = lighter surfaces + hairline borders. NO glow. In light mode, depth comes from soft shadows.

## Motion

```
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1)   /* spring-out, Apple/Linear */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)
--motion-fast: 120ms
--motion-base: 180ms
--motion-slow: 280ms
```

`prefers-reduced-motion: reduce` shortens all transitions to 0.01ms (one of the 5 justified `!important` uses).

10 named keyframes total: `dialog-scrim-in, dialog-card-in, toast-in, bar-grow-in, bar-rect-rise, bar-tooltip-in, kanban-card-in, spin, auth-card-in, settings-fade`.

## Layer order (z-index tokens)

```
--z-base:    1     local stacking, sticky table heads
--z-sticky:  40    sidebar, in-shell popovers
--z-dialog:  100   modal scrim
--z-palette: 105   command palette (above dialog)
--z-toast:   110   always above modals
--z-skip:    200   skip-link wins over toast for a11y
--z-auth:    1000  full-screen auth overlay
```

## Primitives (`src/renderer/components/`)

Universal in `src/renderer/modules/**` (enforced by ESLint `no-restricted-syntax` rule blocking bare `<button>/<input>/<select>/<textarea>`):

- **Button** — variants `primary|secondary|ghost|danger|icon`, sizes `sm|md|lg`, `leadingIcon`, `trailingIcon`, `loading` (Lucide `Loader2` spinner)
- **Field / Select / Textarea** — labelled inputs with caps `.field-label` + optional `hint`, `error`, `wide` (full-row in grid forms)
- **Toggle** — checkbox with title + description (settings pattern)
- **Badge** — pill with tones `success|danger|info|neutral|accent`
- **EmptyState** — icon-in-pill-chip + display-font title + max-w 42ch description + action (dedicated `.empty-state` class, NOT `.module-message`)
- **Dialog** — portal scrim, focus trap, ESC close, body scroll lock, `onCloseRef` to avoid re-focus-snap on parent re-render
- **DetailPanel** — inline detail panel alongside lists (NOT a modal)
- **DataList / DataTable** — list and grid table primitives
- **Combobox** — code→name entity picker (the CNNNN/PLN-NNN pattern)
- **FilterBar** — `<div className="filter-bar">` shell with bare-label layout (caps via `.filter-bar label`)
- **PageHeader** — topbar with eyebrow + title + actions
- **MetricCard / MetricGrid** — dashboard tiles
- **Card** — section panel with eyebrow + title + actions
- **Message** — inline status with `role=alert` (error) or `status` (success/neutral)
- **CommandPalette** — Cmd/Ctrl+K overlay
- **Toaster** — top-right stacked notifications, auto-dismiss 4s
- **ThemeToggle** — flips `data-theme` on `<html>`

## Module CSS colocation

Big namespaces moved out of `styles.css` into colocated `.css` files imported by the consuming `.tsx`:

```
src/renderer/modules/ExpensesModule.css       685L
src/renderer/modules/InvestmentsModule.css    677L
src/renderer/modules/WorkOrdersModule.css     332L  (kanban + summary)
src/renderer/modules/clients/import/ClientImportDialog.css  418L
```

Shared metric-tile rules (`.investment-metrics, .expenses-metrics, ...`) are intentionally duplicated in both Expenses + Investments CSS — independence over `_shared` indirection.

`styles.css` evolved 6089L → 4316L (−29%) over the design-system refactor session.

## Anti-patterns (project-specific)

- Side-stripe borders (`border-left: 3px solid var(--accent)`)
- Gradient text (`background-clip: text`)
- Glassmorphism as default (only Dialog scrim + palette scrim use blur, intentionally)
- Hero-metric template (big number + tiny label + gradient sparkline — already declined)
- Identical card grids
- `<button className="primary">` bare (use `<Button variant="primary">`)
- Hex literals outside `index.html` FOUC bootstrap
- New z-index or breakpoint literals (use tokens)

## Polished slice (the reference oracle)

**Dashboard** and **PaymentsModule** are the polished slice — bespoke layouts, tabular numbers everywhere, sparklines, refined empty states, editorial spacing. When polishing a non-slice module, the oracle is "what would the slice version look like?"

Non-slice modules pending visual pass: Audit, Backups, Plans, Reports, Services, Stock, Users, WorkOrders (Expenses + Investments are bespoke, Settings has its own tabs aesthetic).

# Module Header Actions — Design Specification

**Date:** 2026-07-27  
**Status:** Approved for planning  
**Scope:** Module headers and the shared `Button` primitive

## 1. Context

The ISPM module headers currently flatten action hierarchy. A high-specificity
selector applies the same accent background, border and foreground to every
button inside `.module-header`, even when a button explicitly uses the
`secondary` or `ghost` variant.

The rendered result confirms the problem:

- In Clients, `Importar` (`btn-secondary`) and `Novo cliente`
  (`btn-primary`) both render with the same accent surface.
- In Services, `Atribuir IPs` and `Novo servico` are visually identical.
- In Payments, four operational actions render as four equally dominant blue
  buttons across the header.
- Dark and light themes both lose hierarchy. The light theme additionally uses
  a brown action colour that is disconnected from the blue/cyan ISPM mark.

At 1440 × 900, all audited header buttons rendered at 40 px high, with a 7 px
radius, no shadow and the same theme accent. The issue is therefore not only
stylistic; the CSS cascade is overriding the semantic intent already expressed
by the components.

## 2. Goals

1. Establish an unmistakable hierarchy between primary, utility and critical
   actions.
2. Make `Button` the single source of truth for its visual variant and state.
3. Introduce a reusable header action composition that keeps structure,
   ordering and responsive behaviour consistent across modules.
4. Align primary actions with the blue/cyan ISPM identity in both themes.
5. Preserve permissions, business operations and existing interaction flows.
6. Deliver accessible focus, loading, disabled and reduced-motion states.

## 3. Non-goals

- Redesigning row actions, filter controls or ordinary dialog footers.
- Changing API calls, permissions, confirmation flows or domain behaviour.
- Hiding existing commands behind new menus.
- Reworking the global page shell, navigation or module content.
- Replacing the existing icon library.

Components that already use `.module-header` inside a preview or nested detail
must receive the minimum semantic correction needed to avoid regression when
the global override is removed. Their surrounding dialog or detail layout is
not otherwise in scope.

## 4. Chosen direction

Use a semantic action system rather than a CSS-only reskin or a new command-bar
interaction model.

### 4.1 Action hierarchy

- **Primary:** exactly one dominant command per module header. Examples:
  `Novo cliente`, `Novo servico`, `Nova despesa`, `Gerar mensalidades`.
- **Secondary:** visible utility commands that support the primary task.
  Examples: `Importar`, `Atribuir IPs`, `Recorrentes`, report exports.
- **Critical:** sensitive or exceptional operations that must be discoverable
  without competing with the primary command. Example:
  `Reverter mensalidades`.
- **Context:** controls that change the operating context, such as month
  selectors or report views. These are not styled as commands.

### 4.2 Visual character

The visual language is precise, dark-first and operational:

- Primary buttons use an ISPM blue gradient with a restrained inner highlight
  and short shadow.
- Secondary buttons use a neutral, translucent surface and a low-contrast
  border. Their emphasis increases on hover, not at rest.
- Critical buttons remain neutral at rest, with a red icon/tone cue. The risk
  surface and border become explicit on hover and keyboard focus.
- The treatment must feel dimensional but not glossy, neon or game-like.
- Dark and light themes retain their own surfaces while sharing the same
  semantic hierarchy and blue primary identity.

## 5. Component architecture

### 5.1 `Button`

The shared `Button` primitive remains backwards compatible and owns:

- background, foreground and border;
- radius, padding and minimum height;
- icon spacing;
- hover, active, focus-visible, loading and disabled states;
- transition and reduced-motion behaviour.

Supported semantic variants:

- `primary`
- `secondary`
- `ghost`
- `critical` — new, restrained risk treatment for visible exceptional actions
- `danger` — retained for explicitly destructive confirmations
- `icon`

Header actions use the default 40 px size. Existing `sm` declarations in module
headers are migrated to the standard header size instead of being visually
overridden by contextual CSS.

The Button API must continue supporting leading/trailing icons, loading,
disabled, accessible labels and native button attributes. Loading must preserve
the button’s dimensions and must not duplicate a spinner supplied by a caller.

### 5.2 `ModuleHeaderActions`

Introduce a small composition component with named semantic regions:

```ts
type ModuleHeaderActionsProps = {
  context?: ReactNode;
  secondary?: ReactNode;
  critical?: ReactNode;
  primary?: ReactElement;
  ariaLabel?: string;
  className?: string;
};
```

Responsibilities:

- render context controls separately from commands;
- keep secondary, critical and primary groups in a stable order;
- visually separate critical actions;
- expose the command collection as an accessible named group;
- wrap predictably without compressing labels or the module title;
- place the primary action at the strongest terminal position.

It must not clone children to restyle them. Each `Button` keeps explicit control
of its variant, and the composition owns layout only.

### 5.3 CSS cascade

Remove `.module-header button` from the broad accent-button selector. No
contextual selector may overwrite a Button variant’s colour, border or state.

Header-specific CSS may control only:

- layout and gaps;
- alignment and wrapping;
- group separation;
- responsive placement.

Module-specific selectors such as the Expenses header should be consolidated
into the shared composition where their behaviour is equivalent.

## 6. Visual contract

### 6.1 Geometry

- Header action height: 40 px.
- Border radius: 10–11 px, using the appropriate shared radius token.
- Horizontal padding: 14–16 px.
- Icon size: 16 px.
- Icon/label gap: 8 px.
- Group gap: 8 px; separation between semantic groups: 12–16 px.
- Label weight: approximately 650, with no artificial letter spacing.

### 6.2 Colour and materiality

Create semantic action tokens instead of coupling buttons to the broad theme
accent:

- primary start/end, foreground, border and shadow;
- secondary surface, hover surface, foreground and border;
- critical foreground, icon, hover surface and border;
- focus ring and disabled treatment.

Exact values may be tuned during browser validation, but must satisfy:

- WCAG AA contrast for text and meaningful iconography;
- blue/cyan family for the primary action in both themes;
- neutral dark graphite surfaces in dark mode;
- neutral light surfaces in light mode;
- no brown primary action in light mode;
- no pure-black shadow or hard 1 px outline that makes the button feel flat.

### 6.3 Interaction states

- Hover: subtle surface lift and controlled shadow increase.
- Active: tactile return/press without layout shift.
- Focus-visible: 2 px high-contrast ring with visual separation from the
  control border.
- Loading: stable width, spinner and disabled interaction.
- Disabled: visibly unavailable while retaining legible text.
- Reduced motion: remove transforms and minimise non-essential animation under
  `prefers-reduced-motion: reduce`.
- Transition duration: 140–180 ms with an intentional easing curve.

## 7. Module mapping

| Module/header | Context | Secondary | Critical | Primary |
| --- | --- | --- | --- | --- |
| Clients | — | Importar | — | Novo cliente |
| Services | — | Atribuir IPs | — | Novo servico |
| Plans | — | — | — | Novo plano |
| Users | — | — | — | Novo utilizador |
| Work orders | — | — | — | Nova OS |
| Stock list | Stock category remains outside action group | — | — | Novo material/equipamento |
| Stock detail | — | Editar | — | Movimento |
| Expenses | — | Recorrentes | — | Nova despesa |
| Investments | Month | — | — | Novo investimento |
| Audit | — | Atualizar | — | — |
| Reports | Report view | Exportar CSV | — | — |
| Profit | Month / all-months state | PDF, CSV | — | — |
| Payments | Month | Notificar atrasados; Avisar suspensao | Reverter mensalidades | Gerar mensalidades |

Primary “new” actions receive a consistent leading `Plus` icon unless a more
specific existing icon communicates the operation more clearly. Utility and
critical actions use existing Lucide icons at the shared 16 px size.

## 8. Payments-specific composition

Payments is the stress case for the system:

1. The month selector is rendered as context, not as part of the command run.
2. Notification actions form the secondary group.
3. `Reverter mensalidades` uses the `critical` variant and is visually
   separated from routine actions.
4. `Gerar mensalidades` is the sole primary action and occupies the terminal
   high-emphasis position.
5. All four operations stay visible; no workflow is moved into an overflow
   menu.

At narrower widths, context may take its own row before commands. Command
labels must not truncate. The primary command remains visually dominant after
wrapping.

## 9. Responsive behaviour

- The module title and action composition may wrap without overlap.
- Context controls maintain a usable minimum width.
- Semantic action groups wrap as groups where possible.
- The primary command is never visually sandwiched between utility actions.
- On constrained widths, actions may occupy a new row aligned to the content
  edge; full-width buttons are used only where needed, not by default.
- No horizontal overflow is permitted at supported desktop window sizes.

## 10. Accessibility

- Keep native `<button>` semantics.
- Use `role="group"` and a meaningful `aria-label` for grouped header commands;
  do not use `role="toolbar"` unless arrow-key navigation is implemented.
- Icons paired with visible text remain `aria-hidden`.
- Icon-only buttons require an accessible name.
- Focus must remain visible in dark and light themes.
- Colour is never the sole signal for a critical action.
- Disabled and loading states must be announced through the existing native and
  component semantics.

## 11. Validation strategy

### Automated

- Component tests for all Button variants and state classes.
- Component tests for `ModuleHeaderActions` region ordering, optional regions
  and accessible group naming.
- Module-level assertions for the approved primary/secondary/critical mapping.
- Regression test ensuring a secondary button inside `.module-header` retains
  its secondary visual class and is not contextually promoted.
- Run renderer tests, full test suite, TypeScript checks and lint.

### Browser

Capture and inspect at minimum:

- Clients, Services and Payments in dark mode at 1440 × 900.
- Clients and Payments in light mode at 1440 × 900.
- Payments at a constrained supported window width.
- Keyboard focus on primary, secondary and critical actions.
- Loading and disabled states without layout shift.
- Reduced-motion behaviour.

Use isolated/mocked API responses during visual validation so no real business
data or operation is touched.

## 12. Acceptance criteria

1. `Importar` and `Novo cliente` are immediately distinguishable by hierarchy.
2. No secondary or ghost header button is promoted by selector specificity.
3. Every mapped header has no more than one primary action.
4. Payments clearly distinguishes context, routine utility, critical reversal
   and primary generation.
5. Primary actions use the ISPM blue family in dark and light modes.
6. Button states meet the visual, motion and accessibility contract.
7. Header layouts do not overflow at supported desktop widths.
8. Permissions and business behaviour remain unchanged.
9. Automated checks pass and browser evidence is captured for both themes.


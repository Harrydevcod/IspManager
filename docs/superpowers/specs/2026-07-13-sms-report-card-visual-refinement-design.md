# SMS report card visual refinement design

**Date:** July 13, 2026

## Goal

Refine the monthly SMS delivery report card in **Configurações > SMS** so it
has clearer hierarchy, more precise alignment, and better responsive behavior
without changing its content or functionality.

## Scope

Keep the existing report section, **Canal SMS** eyebrow, **Relatório de entrega
de SMS** heading, native month selector, five delivery states, state order,
monthly data flow, loading behavior, and accessibility semantics.

This refinement does not change report queries, renderer props, status labels,
counts, colors assigned to statuses, error handling, or Android companion
connectivity.

## Visual direction

Use a restrained editorial treatment consistent with the dark-first ISPM
interface. The panel remains a quiet supporting surface rather than becoming a
separate dashboard.

- Balance the header with the title block on the left and the month selector on
  the right at desktop widths.
- Let the month selector wrap below the title block when the component becomes
  narrow, without clipping or horizontal scrolling.
- Give the numeric values moderately stronger size and weight while reducing
  the visual noise of their uppercase labels.
- Distribute the five indicators evenly across the available width and use
  subtle separators to preserve scanability.
- Keep semantic color on the numeric values only. Borders, labels, and the
  background stay neutral so failures and pending delivery remain meaningful.
- Refine padding, border, radius, and background contrast without adding drop
  shadows, gradients, decorative icons, or animation.

## Component structure

Preserve the semantic structure in `SmsTab`:

1. A `section` labelled by the existing `h3`.
2. A header containing the eyebrow/title block and native month field.
3. A loading status or the five-item status group.

The implementation should remain CSS-led. Markup changes are allowed only when
they improve the existing semantics or enable the responsive layout without
changing the component API.

## Responsive behavior

At normal settings-panel widths, the heading and month selector occupy opposite
ends of the header and the five indicators form one balanced row. At narrower
component widths, the header wraps naturally and the indicator group adapts to
multiple columns with complete labels and no hidden functionality.

Use CSS container queries on `.sms-delivery-report` so wrapping responds to the
card's available inline size rather than the viewport. Do not add JavaScript for
layout. The result must remain usable in both light and dark themes.

## Accessibility

- Preserve `aria-labelledby="sms-delivery-report-title"` on the report section.
- Preserve the semantic `h3` and the visible **Mês** label.
- Preserve `role="status"` for loading feedback and the labelled status group.
- Do not rely on color alone: every status retains its text label.
- Maintain visible focus behavior and native keyboard operation for the month
  input.

## Verification

- The report content, order, selected month, callback behavior, loading state,
  and stale-response guard remain unchanged.
- The header aligns across desktop and narrow widths without overflow.
- All five status values remain legible at zero and at larger values.
- Light and dark themes retain sufficient contrast.
- Focused renderer tests pass.
- Repository typecheck, lint, renderer tests, main-process TypeScript build, and
  whitespace validation pass.

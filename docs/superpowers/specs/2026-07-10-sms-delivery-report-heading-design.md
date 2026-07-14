# SMS delivery report heading design

**Date:** July 10, 2026

## Goal

Make the SMS status cards in **Configurações > SMS** immediately identifiable
without changing their data or behavior.

## Interface design

Add the heading **Relatório de entrega de SMS** immediately above the existing
SMS status card group. Align the heading with the left edge of the cards and use
the established section-heading typography and spacing from the settings UI.

Keep the existing cards, counters, labels, colors, and order unchanged. Do not
add a subtitle, banner, date range, filters, or new delivery states.

## Accessibility

Render the text as a semantic heading at the appropriate level for the existing
settings page hierarchy. Keep the card group label available to assistive
technology.

## Verification

- The heading appears directly above the SMS status cards.
- The heading reads exactly **Relatório de entrega de SMS**.
- The layout remains clear at the supported desktop widths.
- Existing SMS status counters and behavior remain unchanged.
- Type checking and the relevant renderer tests pass.

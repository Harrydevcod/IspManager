# SMS report month alignment design

**Date:** July 10, 2026

## Goal

Place the **Mês** selector immediately beside the **Canal SMS / Relatório de
entrega de SMS** title block in the monthly SMS report header.

## Design

Keep the existing semantic markup and report behavior unchanged. The current
header already uses a left-aligned flex container with wrapping. Remove the
automatic inline margin from `.sms-report-month` so the selector follows the
title block at the existing horizontal gap.

At desktop widths, the title block and selector stay on the same line and align
along their lower edge. When the available width cannot hold both controls, the
existing flex wrapping moves the selector below the title without horizontal
overflow.

Do not move the selector to the far edge, embed the month in the title, change
the selector width, or modify report data loading.

## Verification

- The selector appears directly to the right of the title block at desktop
  widths.
- The selector wraps below the title at narrow widths without overflow.
- The heading, **Mês** label, selected value, cards, and loading state remain
  unchanged.
- Renderer tests, type checking, and lint pass.

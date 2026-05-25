# ISPM

> ISP Manager desktop app for Cabo Verde. Built for small/medium internet service providers managing 50–2000 active clients across the islands.

## Users

**Primary:** Operations team at a Cape Verdean ISP — typically 1 owner-operator (CTO/founder), 1–3 technicians, occasional admin assistant. Daily work: register new clients, generate monthly invoices, send WhatsApp reminders, dispatch field technicians, reconcile payments, track stock of routers/cables/ONUs, file SAF-T to DNRE quarterly.

**Context:**
- Desktop Electron app, runs offline-first on Windows (the team's primary work surface)
- Used on 1280px–1920px screens, often a single 24" monitor in a small office during daylight
- The owner switches into dark mode in the evening when invoicing at home

**Mental model:** Primavera/Odoo familiarity (Cape Verdean SMBs know these), but the team wants something they're proud to show off. Not "another ERP screen."

## Brand / Tone

**Voice:** Quiet authority. The owner is the technical decision-maker — they don't want hand-holding, they want fluency. Portuguese (PT, not BR) for the UI; English for code/CSS.

**Personality:** Editorial. Confident. Heritage gold accent (warm `oklch(80% 0.112 76)`) on neutrals tinted toward the same hue — this isn't a generic SaaS palette. The accent IS the brand.

**Anti-references:**
- Generic SaaS card grids ("Welcome back! 📊 Here are your stats!")
- Cream-colored ERP from the 1990s
- Pastel dashboards
- Anything that screams template

## Strategic principles

1. **Fiscalidade first.** Every UI decision must respect Cabo Verde fiscal law (Lei 21/VI/2003, Portaria 47/2021 SAF-T). Document numbering is sequential and gapless. Anulação, never deletion.
2. **Local trust.** The data lives on the customer's machine in SQLite. No cloud lock-in. Backups are first-class.
3. **Density over decoration.** The owner sees this every day. Numbers should be tabular, comparisons aligned, no decorative chrome that doesn't earn its pixels.
4. **Multi-tenant ready.** Architecture supports SaaS later, but ship single-tenant desktop first.

## Register

`product` — design SERVES the workflow. This is an everyday tool, not a marketing page.

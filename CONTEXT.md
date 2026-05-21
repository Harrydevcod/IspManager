# ISPM Context

ISPM is a desktop application for day-to-day ISP operations in Cabo Verde.

## Core areas

- `Clientes` - customer records, contact details, island, zone, and status.
- `Planos` - internet plans with speed, connection type, pricing, and active state.
- `Servicos` - customer subscriptions tied to plans.
- `Pagamentos` - billing records, overdue tracking, receipts, and invoices.
- `Documentos de cobranca` - invoice and receipt PDFs generated from payments.
- `Stock` - equipment catalog and inventory movements.
- `Relatorios` - revenue, overdue debt, stock value, and operational summaries.
- `Configuracoes` - company profile, billing defaults, document prefixes, and WhatsApp settings.
- `Historico tecnico` - structured events for installations, maintenance, equipment swaps, visits, and service changes.

## Domain relationships

- One `Cliente` can have multiple `Servicos`.
- Each `Servico` belongs to exactly one `Cliente`.
- Each `Servico` is associated with one `Plano` at a time.
- Each `Pagamento` belongs to one `Servico` and one `Cliente`.

## Operational rules

- Automatic suspension acts on each `Servico` independently.
- A payment reactivates the related `Servico` immediately.
- Suspension from debt applies only to the overdue `Servico`, not to all services of the same `Cliente`.
- Manual suspension overrides are reserved for `administrador` and must be logged.
- Cancelled services keep their invoices and payments visible in history.
- `tecnico` can read operational data and record technical events, but cannot edit customer identity or billing data.
- `Historico tecnico` uses fixed event types with notes for details.
- `cancelado` is a service status, not a technical-history event type.
- `tecnico` can create technical events only for services assigned to them, unless `administrador` overrides.
- Technical events can be created from both the client view and the service view.
- Dashboard alerts are derived from current state; automatic actions belong to billing and control jobs, not the UI.
- Scheduled control jobs run inside the backend process for now.
- Scheduled job timing is stored in configuration rather than hard-coded.
- Configuration includes per-job enable/disable toggles and grace-period thresholds.
- Reports include both operational KPIs and technical workload metrics.
- Report exports support both PDF and Excel.
- Alert thresholds are configurable per metric.
- The system keeps an audit log of critical operations.
- The audit log is visible only to `administrador`.
- The UI supports dark mode as a user preference.
- The domain language stays platform-neutral even though the current desktop package targets Windows.
- Search and filters prioritize exact identifiers before broad text matches.
- A `Servico` can have multiple installed devices at the same time.
- Current installed devices are tracked in a separate assignment table, not in `Historico tecnico`.
- Device assignments keep history when a device is replaced.
- Device assignments belong to a `Servico`; the `Cliente` is implied by the service.
- Only one device assignment is active per device at a time.
- Replaced device assignments keep an explicit `end_date`.
- `IP` and `MAC` belong to the active device assignment record, not to the service summary.
- Device assignments store the responsible technician for the current installation.
- Device replacement closes the old assignment and opens the new one in the same transaction.
- Device assignments store both the equipment catalog model and the physical unit identity.
- Physical unit identity is optional at first, but should be supported.
- A customer history view merges services, payments, technical history, and device assignments.
- The customer history timeline shows state-changing events only, ordered newest first.
- Plan changes appear in the customer history timeline as their own events.
- Payments, suspensions, reactivations, and overrides appear as separate timeline events even on the same day.
- The customer history timeline keeps final-state records visible instead of hiding them.

## System language

- Currency: `CVE`
- External messaging provider: `UltraMsg`
- Primary communication channel used by the app: `WhatsApp`
- Operational geography terms used in the UI and data model: `ilha` and `zona`

## Product goals

- Keep the customer, billing, and support workflows fast enough for daily use.
- Preserve stable terminology across UI labels, backend routes, issue titles, and docs.
- Prefer incremental changes that keep the Electron, React, Fastify, SQLite, and Drizzle stack working together.

## Validation baseline

- `npm.cmd run typecheck`
- `npm.cmd test`
- `npx.cmd tsc -p tsconfig.main.json`

## Notes for future docs

- Use the terms in this file when naming features, tests, tickets, and refactors.
- Add ADRs under `docs/adr/` when a decision needs to be preserved beyond the current implementation.

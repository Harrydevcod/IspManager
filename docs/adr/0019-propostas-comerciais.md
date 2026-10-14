# Commercial proposals preserve the offered terms

A **Proposta** records an offer to an existing client or an interested recipient
who is not yet registered. It has its own tables, document series, and lifecycle.
It does not create clients, subscriptions, installations, invoices, receipts,
stock movements, or treasury movements. Recording acceptance is a manual
commercial decision, not an operational order.

Each ordered line is either a one-time cost or a monthly charge. Selecting a
plan adds separate subscription and installation lines; catalog products can
be offered as a sale or monthly rental. Operators may negotiate the unit price,
including a free installation. The two totals remain separate in the form and
PDF. No combined grand total or first-month due date is inferred.

Unit prices and totals use integer centavos. Quantities use up to three decimal
places for products and free lines and whole units for plans and installation.
The backend rounds each line before summing its period. An offer has at most
100 lines and at least one positive period total. VAT-inclusive presentation
follows the current company settings, calculated separately for each period.

Drafts are editable and have no definitive number. Issuing assigns
`PR-AAAA-00001` from a dedicated annual sequence and freezes the recipient,
descriptions, quantities, prices, conditions, company identity, currency, and
VAT presentation. Later changes to the client, catalog, or settings cannot
rewrite the offer. Optional foreign keys retain commercial history when their
referenced record is removed. PR is reserved against invoice and receipt
prefixes; historical fiscal numbers are never rewritten.

An issued offer is valid through its chosen date, with a default of 30 days.
Expiration is derived when reading and never needs a job or a write. Acceptance
requires the current issued version within validity and identifies the person
who accepted. Refusal and cancellation require a reason. Administrators and
operators manage proposals; only an administrator may cancel an accepted
proposal. Technicians have no access to either the module or its APIs.

A revision starts as a linked draft while the previous version keeps its state.
Only one pending revision can exist in a chain. Issuing the revision allocates
a new number and replaces the previous version atomically. If the previous
version has meanwhile been accepted, issuance fails. Accepted offers cannot be
revised; subsequent changes start a new independent proposal.

Every write carries a concurrency version. Stale writes return conflict, while
repeated issuance returns the existing document. Number allocation, the frozen
snapshot, supersession, and mandatory audit share a SQLite transaction. An
audit failure rolls back the whole operation. Delivery logs record manual
sharing, with date, channel, and note; no automatic message is sent.

The A4/A5 PDF follows the ISPM document palette, clearly says **Proposta comercial
— não constitui fatura**, and never prints a fiscal QR code. Draft, cancelled,
and replaced states are visible without changing the original commercial
content. The revision chain identifies the related offer numbers.

The UI initially selects A5; its A4/A5 selector applies to draft previews and
issued PDF downloads. Requests without a format keep A4 for compatibility.
Both portrait formats align issuer and recipient side by side, preserve
separate one-time and monthly totals, and paginate long content with repeated
table headers.

## Research behind the decision

The [Splynx tariff documentation](https://wiki.splynx.com/configuring_tariff_plans)
distinguishes recurring and one-time plans. This supports keeping installation
and monthly charges separate in the ISPM offer.

[Odoo subscription documentation](https://www.odoo.com/documentation/18.0/applications/sales/subscriptions.html)
uses quotations with recurring plans and order lines. ISPM adopts the explicit
offer composition while leaving subscription activation manual in this scope.

[ERPNext quotation documentation](https://docs.frappe.io/erpnext/quotation)
describes offers to leads or customers with validity and commercial terms,
and formal amendment of submitted offers. ISPM preserves the emitted version
and links revisions, replacing it only when the next version is issued.

Sources checked on October 13, 2026. These are product design references;
they do not establish the fiscal or legal status of an ISPM proposal.

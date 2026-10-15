# Documentos separates commercial offers from fiscal records

Documentos replaces the Propostas navigation entry with Informativos and Fiscais.
The commercial offer engine owns proposals, quotations and proformas. They share
composition, validity, delivery, acceptance and revision rules, but use independent
annual PR, OR and PF series. Existing proposal records and API routes remain valid.
Type changes are allowed only in independent drafts; revisions inherit their type.

A proforma requires a manually entered advance request in integer CVE centavos,
a description of what it covers, payment conditions and an optional civil due date.
The amount may cover multiple months and is not derived from offer totals. It is
presented separately without adding another charge or VAT calculation. Issuance
freezes payment instructions and the existing printable treasury bank accounts;
issued PDFs never refresh them from settings. Legacy proposal snapshots have no
payment request and remain readable without enrichment from current settings.

Informative issuance and acceptance never create invoices, receipts, customer debt,
services, inventory movements or treasury movements. Acceptance records agreement
to the offer, not payment. Receipt of an advance needs the applicable fiscal process
and is outside this version's proforma workflow.

The fiscal archive is a paginated read projection of existing payments and receipts,
not a second document ledger. Each partial receipt is a document; internal receipts
of sale tickets are excluded. Legacy payment-level receipts without receipt rows
remain accessible through their existing PDF route. Manual invoice and sale-ticket
forms are reused in Documentos; collection, receipt registration and reversals stay
in Financeiro, linked by the originating payment id. The sale-ticket cancellation
flow is reused with its existing authorization and return requirements.

Number allocation, issuance snapshots and mandatory audit remain atomic. Reserved
PR/OR/PF prefix conflicts block new fiscal issuance while permitting correction of
legacy settings without renumbering history. OR and PF follow the existing PR
recovery mechanism.

The Fiscais label organizes existing document types; it does not assert DNRE
authorization. This version adds no electronic fiscal XML, digital signature,
DNRE submission, credit/debit notes or automatic conversion from informative offers.

Research: [DNRE e-Fatura](https://ww.dnre.gov.cv/) identifies invoices and other
fiscally relevant electronic documents and distinguishes their authorized XML from
PDF representations. [DNRE IVA guidance](https://www.mf.gov.cv/web/dnre/dire%C3%A7%C3%A3o-geral-das-contribui%C3%A7%C3%B5es-e-impostos)
distinguishes advance receipt from a commercial request. Consulted 2026-10-14.

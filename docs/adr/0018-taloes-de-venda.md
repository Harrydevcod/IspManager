# Talões de Venda use one atomic sale transaction

Anonymous sales belong to a unique system client identified by `system_kind`,
not by name or a fixed ID. A Talão de Venda (`TV`) has its own document type
and series, while reusing the receipt and treasury ledger so revenue is counted
once. `VD` describes a cash sale and does not introduce another document.

Numbering, full settlement, stock withdrawal, serial reservation, and mandatory
audit commit in the same SQLite transaction and on the same connection. An
immediate transaction acquires the write lock before checking stock or the
idempotency key, so concurrent sales either recover the same TV or reject an
unavailable unit. An emission request key is unique and bound to its payload.
TV numbering uses the year of its issue date. Its prefix is reserved;
conflicting legacy invoice/receipt prefixes must be corrected in settings,
without renumbering historical documents. A sale cannot predate the opening
date of its treasury account because those movements do not enter its balance.

Cancellation requires an administrator, password confirmation, a reason, and
confirmation that the products were returned. The original TV remains in the
history; its receipt is voided, treasury is reversed, stock is returned, and
serial reservations are released atomically. Generic payment and document
routes reject TV operations to preserve those invariants.

The customer receives the TV in A5, A4 or 80 mm format. A5 is initially selected
in the UI; requests without a format keep A4 for API compatibility. A4 and A5
align the issuer and customer side by side and repeat table headers on
continuation pages. The internal receipt is a
ledger entry, not an additional customer invoice. TV follows the configured
currency and VAT presentation; this decision does not assert fiscal equivalence
between TV and Fatura. Partial returns and Stripe settlement are out of scope.

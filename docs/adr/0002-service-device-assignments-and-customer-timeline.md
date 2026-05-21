# Service Device Assignments and Customer Timeline

## Status

Accepted

ISPM needs to represent real ISP operations without collapsing technical state into the service row. We decided to keep installed devices in a separate assignment table tied to `Servico`, with explicit start and end dates, the current `IP`, `MAC`, and responsible technician stored on the active assignment, and replacement history preserved when devices change. We also decided that the customer history view should be a chronological timeline of state-changing events only, including plan changes, payments, suspensions, reactivations, and overrides, while final-state records remain visible instead of disappearing.

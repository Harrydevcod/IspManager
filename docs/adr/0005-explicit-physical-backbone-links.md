# ADR 0005: Explicit Physical Backbone Links

## Status

Accepted. Supersedes [ADR 0004](0004-topology-inventory-lineage-read-model.md).

## Context

ADR 0004 rendered the topology from the only relationship the database could prove at
the time: a catalog row marked as backbone inventory (`equipment_catalog.backbone_qty`)
and the assignments installed from that same catalog. That inference could not answer
the question operators actually ask — *which physical unit does this client hang off,
and where is it installed?* — because a catalog aggregate has no serial number, no IP,
no location, and no identity that survives a transfer.

Backbone quantity was also a poor system of record: it counted units without naming
them, could not express maintenance or retirement, and made the CAPEX metric depend on
a number an operator typed into a catalog form.

## Decision

- **Physical identity.** `backbone_devices` stores each backbone unit as its own row
  with name, catalog model, serial number, asset tag, IP, MAC, island, zone, status
  (`active`/`maintenance`/`retired`) and notes. Serial number and asset tag are unique
  among non-retired units through partial indexes, so a retired unit never blocks the
  reuse of a tag.
- **Temporal one-active-link invariant.** `backbone_assignment_links` links an
  assignment to a backbone device over time. A partial unique index on
  `(assignment_id) WHERE ended_at IS NULL` guarantees that an assignment hangs off at
  most one backbone at any moment; a transfer closes the previous link and opens the
  next one inside a single transaction. History is kept — links are closed, never
  deleted.
- **Provisional migration.** Migration 33 expands every positive `backbone_qty` into
  that many `backbone_devices` rows, named `<brand model> #n` and flagged
  `provisional = 1`. No link is invented: the migration creates identities, not
  relationships. Provisional units are surfaced in the workspace and inspector so an
  operator can complete their real facts. Migration 34 then drops
  `equipment_catalog.backbone_qty`, so the catalog can no longer disagree with the
  physical inventory.
- **Adoption of the abandoned migration 31.** A development build that never reached
  `main` applied a different migration 31 (`backbone_devices` plus
  `backbone_client_links`) on at least one field database, where an operator had
  already recorded real units and links. Version 33 therefore adopts those rows —
  names, IPs and links kept, `active` mapped to `status`, `provisional = 0` because the
  facts are real — and only generates provisional units for the catalogued quantity
  that the adopted rows do not already account for. The new chain skips versions 31
  and 32 so it can never collide with that recorded history.
- **`defined_link` semantics.** Every rendered edge between a backbone and a CPE means
  "an operator recorded this link", nothing more. The topology still makes no claim
  about reachability, RF association, routing adjacency, ping, SNMP, or live health.
  Assignments with no open link are counted as `Sem ligação` and are never attached to
  a backbone by inference.
- **Retired units are absent from the active map.** The read model filters
  `status <> 'retired'`, and the backbone detail states that fact instead of offering a
  navigation that would land nowhere.
- **Audited, permissioned mutations.** Create, edit, link, transfer, and unlink run
  through `POST/PATCH` routes restricted to managing roles and record narrow audit
  events in the same transaction as the mutation. Technicians keep read access.
- **Lazy loading is unchanged.** `GET /api/topology` still returns the logical root,
  backbone nodes, core edges, and aggregate counts; assignments load per expanded
  branch and stay cached for the renderer session. The map remains a lazy chunk, now
  behind the `Topologia` tab of a two-tab module whose first tab is `Backbone`.

- **The spine is a graph, not a tree** (migration 36). `backbone_links` records who
  feeds whom, replacing the single `upstream_device_id` column of migration 35. A
  device with no row is fed by the Internet; a device with several rows aggregates
  them — the concrete case being a multi-WAN router fed by two, three or four
  Starlink terminals for capacity. `root:isp` stays logical: it is the Internet, never
  an antenna, and it collects every uplink that exists, whether they are separate
  antennas on different islands or several links converging on one unit. No
  single-root constraint may be reintroduced — no index, CHECK, validation, or layout
  shortcut. An internet source has no type of its own: it is a backbone like any
  other, identified by having no upstream. Cycle detection is a depth-first walk with
  a visited set, because a graph offers more than one path to the root and climbing
  one of them was blind to a cycle closed through another.

## Consequences

- CAPEX visibility is computed from non-retired physical units joined to their catalog
  landed cost, so the metric follows the inventory instead of a typed quantity.
- The Stock module no longer edits backbone quantities; the backbone workspace is the
  single place where physical units are created and maintained.
- Provisional rows are a visible migration debt by design: they carry a real identity
  but incomplete facts until an operator fills them in.
- Ending a service assignment closes its open backbone link, so the map cannot keep
  showing a link for equipment that is no longer installed.
- The synthesized root `root:isp` from ADR 0004 survives; everything else in that ADR —
  catalog aggregates, `inventory_lineage` edges, and the `Sem linhagem` count — is
  replaced by the physical model described here.

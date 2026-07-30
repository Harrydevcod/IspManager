# ADR 0004: Topology as Factual Inventory Lineage

## Status

Superseded by [ADR 0005](0005-explicit-physical-backbone-links.md)

## Context

ISPM needs an operational topology view before the persisted model contains physical
links, upstream-device relationships, reachability probes, ping, SNMP, or telemetry.
Presenting those facts as if they existed would turn a useful inventory view into a
misleading network map.

The current inventory stores backbone quantity on `equipment_catalog` and installed
physical units in `service_device_assignments`. It does not store an explicit
CPE-to-backbone relationship. A catalog row can therefore prove that a model is used
as backbone inventory, but cannot prove RF, Ethernet, fibre, or routing connectivity
between two physical units.

## Decision

- Synthesize one logical root with the stable identity `root:isp` and the label
  `Internet / Core ISPM`. It is a navigation and aggregation root, not a persisted
  physical device.
- Represent each catalog row with `backbone_qty > 0` as a backbone aggregate. A
  backbone node intentionally has no IP, MAC, serial number, or asset tag because
  those attributes belong to physical assignments, not to the catalog aggregate.
- Treat active assignments of that same catalog as having
  `inventory_lineage` beneath the backbone aggregate. This relationship means only
  “physical units assigned from this backbone-designated catalog”.
- Keep assignments whose catalog has no positive `backbone_qty` attached only to
  the logical root in search results. Count them separately as `Sem linhagem`, do
  not draw a backbone edge for them, and do not infer an upstream device.
- Describe every rendered edge as inventory lineage. The topology must not claim
  reachability, live health, RF association, routing adjacency, ping, SNMP, or
  real-time connectivity.
- Keep `GET /api/topology` small: logical root, backbone aggregates, core lineage
  edges, and aggregate counts only. Load physical assignments per expanded backbone,
  cache successful branch responses for the renderer session, and isolate retry
  state per branch.
- Keep the renderer module lazy-loaded so React Flow and Dagre remain outside the
  initial application chunk.

## Consequences

- Operators can see the portion of inventory lineage that the database can prove,
  while data gaps remain visible instead of being hidden or fabricated.
- The total physical-assignment count can be greater than the number of mapped CPEs;
  the UI exposes both mapped and unmapped counts explicitly.
- Searching an unmapped assignment can still open its factual inspector, but the
  canvas will not place it under a backbone.
- If ISPM later persists an explicit physical upstream relationship, this catalog
  inference must be replaced by that relationship and migrated without reinterpreting
  historical data.

# ADR 0007: Network Access Control (MikroTik migration path)

## Status

Accepted — the RouterOS reconciliation job is implemented. Suspension by PPP profile extends this decision.

## Context

ISPM decides *who should have service*: billing marks a client overdue, an operator suspends
a service, a cancellation cascades. None of that reaches the network. Today the plant is
TP-Link (CPE710/Pharos point-to-point, TL-S5 switches) with no central controller and no
usable management API, so cutting a non-paying customer means somebody drives to a tower or
logs into a CPE by hand. Reconnecting means the same trip again.

ADR 0005 mapped the physical network and the ICMP probe (migration 0037) made it observable —
but observation is read-only by design, for the same reason: there is nothing to write to.

The plan is to put a **MikroTik router (RouterOS)** at the head of the network. When it lands,
ISPM can enforce what it already decides. This ADR fixes the shape of that integration now, so
the migration is a new module rather than a rewrite of how suspension works.

Two failure modes shape the decision:

- **Split brain.** If the router and the database can each be the truth, they will disagree —
  a customer suspended in ISPM but still online, or paid-up and still cut off. The second one
  costs a phone call; the first one costs money every month, silently.
- **A control plane that hides its actions.** Cutting a customer's internet is not a UI toggle:
  it is an act with a date, an author and a reason, and it must survive being questioned three
  months later.

## Decision

- **The database is the source of *intent*; the router holds *reality*.** ISPM never reads the
  router to decide what should happen. It computes the desired access state from the service
  status it already owns, then reconciles the router towards it. A divergence is a finding to
  show, never a reason to change intent.

- **One door for the transition.** `changeServiceStatus` (`src/backend/lib/services.ts`) is the
  only place a service's status moves. Both existing callers — the service form (`updateService`)
  and the client cascade (`routes/clients.ts`) — go through it, and it writes a `service_events`
  row (`suspensao` / `reativacao` / `cancelamento`, migration 0038) with the reason. The
  enforcement layer subscribes to that transition; it does not get wired into each caller.
  This is the part that is built today, and it earns its place regardless of MikroTik: the
  customer timeline finally records when and why service stopped.

- **Enforcement is a reconciliation job, not a fire-and-forget call.**
  `lib/network-enforcement.ts` runs on the existing `runJob` scheduler (like `network_probe`),
  compares desired vs. actual for every service, and applies the difference. A call that fails
  because the router is unreachable must not leave the system believing it succeeded — the next
  tick tries again. Fire-and-forget on a link that drops is how split brain starts.

- **PPPoE secrets first.** With PPPoE the customer identity already exists on the router (one
  secret per service). A suspended service keeps its secret enabled on the configured suspension
  profile (`routerosSuspendedProfile`, default `SUSPENSO`); a cancelled service has its secret
  disabled. Setting the suspension profile to an empty string restores disabling for suspended
  services. The suspension profile must already exist on the router and provide the intended
  minimal access. Where a customer is on static IP / bridge, the fallback remains an address-list
  that a firewall rule drops.

- **Credentials are per-installation and never leave the machine.** RouterOS API user, password
  and endpoint live in `app_settings` like the other integrations, on the LAN, over the REST API
  with the router's own certificate. No cloud relay, no phoning home. The API user is restricted
  to the permissions the integration needs, not `full`.

- **Off by default, dry-run first.** The job ships disabled. The first mode logs what it *would*
  change without touching the router, so the mapping between services and PPPoE secrets can be
  proved against the real plant before anything is cut. Same discipline as the probe and the
  automatic notices: an integration that can cut a customer's internet does not arrive already
  switched on.

- **Nothing is cut without a trail.** Applied network access transitions write an audit row
  and a `service_events` entry. If the router was changed outside ISPM, reconciliation reports the
  divergence rather than silently overwriting the operator's manual work.

- **A suspension profile takes effect immediately.** On entering or leaving that profile, the
  reconciler changes the secret profile, disconnects its current PPP session and records
  `corte_rede` or `reposicao_rede`. A change between ordinary plan profiles waits for the next
  login. Before enabling a disabled secret, the reconciler applies its profile; a failed profile
  change prevents enabling that service. The mass-cut limit counts both disabling an enabled
  secret and moving an enabled secret to the suspension profile. When it trips, every action for
  each affected service is skipped. Reactivating onto a plan without a PPP profile restores the
  configured base profile if the secret is still on the suspension profile.
  If the configured suspension profile is absent or cannot be confirmed, suspended services
  fall back to disabled secrets. If the profile PATCH fails after verification, an enabled
  secret is disabled and its session disconnected. These cuts remain subject to the same
  mass-cut limit, and the profile error remains visible on the service.

## Consequences

- Suspension gains a history today: `service_events` records the transition and the reason,
  which is visible in the customer timeline and countable in the operations panel.
- The service form no longer writes `status` directly; the field is applied through the door.
  Any new caller that flips status with raw SQL is a bug, and reviewable as one.
- The RouterOS client, the service↔PPPoE mapping, the reconciliation job and its settings now
  enforce the status decided by `changeServiceStatus`. Services without PPPoE credentials still
  require field work. The probe (migration 0037) observes reachability separately from intent.

## Alternatives rejected

- **Reading state from the router.** Makes the router a second source of truth and turns every
  disagreement into a coin flip.
- **Enforcing inside each caller.** The cascade and the form would each grow a network call, and
  the third caller would forget. One door, one subscriber.
- **Building the RouterOS client now.** Code with no consumer, tested against nothing, rotting
  until hardware arrives. The seam is what has to exist early; the client is a week's work when
  there is a router to point it at.

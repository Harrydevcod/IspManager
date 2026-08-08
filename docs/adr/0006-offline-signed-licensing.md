# ADR 0006: Offline Signed Licensing

## Status

Accepted.

## Context

ISPM shipped as a public GitHub release with no notion of a customer, an entitlement,
or a validity period. Turning it into a paid product needs a mechanism that answers one
question at runtime — *is this installation entitled to operate?* — under constraints
that rule out most of the obvious answers:

- **The app is offline-first.** It runs on a desktop in a Cape Verdean ISP office where
  connectivity is intermittent by nature. A licensing check that requires the network is
  a licensing check that will, on some morning, stop a business from invoicing.
- **The data belongs to the customer.** It lives in SQLite on their machine. Any
  enforcement that holds their client records hostage is both wrong and commercially
  suicidal in a market that runs on word of mouth.
- **Two offers were chosen**: a subscription that expires, and a perpetual licence that
  never does. The perpetual promise is the harder one to keep, because it must survive
  in code long after the commercial relationship ends.
- **Billing is manual at first** — bank transfer or Vinti4, with the licence issued by
  hand. There is no payment gateway and no licence server to build against.

## Decision

- **Signed claim, verified offline.** A licence is a JSON claim signed with Ed25519
  (`node:crypto`, no new dependency). The public key is embedded in the build; the
  private key never leaves the issuer's machine. Verification is local and needs no
  network, ever.
- **One mechanism, two policies.** `bind: "machine"` ties a licence to an installation
  through a machine fingerprint; `bind: "none"` is a plain unlock key. Both are the same
  claim and the same code path — the difference is one comparison, not a second system.
- **Perpetual licences never expire.** The schema *rejects* a perpetual claim carrying
  `expiresAt`, so an issuer mistake cannot kill a licence that was sold as permanent.
  What lapses is `maintenanceUntil`, and it withdraws only the right to updates.
- **The worst state is read-only, never locked.** An expired or invalid licence returns
  402 on writes and passes every read. Consultation, document generation and the entire
  backup subsystem — including restore — stay available in all states. The exempt-prefix
  list in `routes/license.ts` (`/health`, `/api/license`, `/api/auth`, `/api/backups`) is
  the enforcement of that promise, and is covered by tests that assert what does *not*
  get blocked.
- **Activating is open to every user; removing is not.** Whoever is at the machine when a
  licence lapses can unlock the operation with the file the owner received, without
  waiting for an administrator — the person blocked from working is rarely the person
  holding the admin password. The exposure is small and bounded: only a licence with a
  valid signature, within its validity and for this machine is accepted, a rejected
  licence never replaces the one already installed, and the audit log records who
  activated. Removing a licence stays admin-only, because that is the action that puts
  the installation into read-only. Reading the state needs no session at all, since the
  screen must render before login.
- **State lives outside the database.** `license.json` sits in `resolveDataDir()`, not in
  SQLite, so restoring a backup taken on another machine does not carry a licence with it.
- **Licensing is inert until a key is configured.** With `EMBEDDED_PUBLIC_KEY` empty the
  gate does nothing and the product behaves exactly as it did before. The two possible
  build mistakes are asymmetric: shipping without enforcement is caught by the first
  activation test, while shipping a build that locks paying customers into read-only is
  an incident. The default fails toward letting people work.
- **No licence server.** `scripts/issue-license.ts` signs licences on the vendor's
  machine and records each sale in a local registry. It emits exactly the artefact a
  server would emit later, so introducing one is an additive change.

## Consequences

- Renewal is a manual re-issue: a new file, emailed. This is acceptable at the scale
  manual billing implies (tens of customers) and is the explicit trigger for building
  the server.
- The trial resets if the data directory is deleted. Closing that hole requires
  registration or a server; it is not worth the cost against the fraud it prevents.
- The machine fingerprint is a composite of hostname, platform, architecture and CPU
  model. Renaming the machine or replacing the CPU invalidates it and requires a support
  re-issue. RAM and MAC addresses were deliberately excluded — a memory upgrade or a USB
  network adapter must never invalidate a licence. If re-issues become frequent, the
  upgrade path is the Windows registry MachineGuid.
- Enforcement is client-side and therefore defeatable by repackaging the Electron app.
  This is accepted: the mechanism targets casual copying between ISPs and continued use
  after expiry, not a determined attacker. No obfuscation is planned.
- **Scheduled jobs follow the same rule as the UI.** Automatic billing, recurring
  expenses, overdue notices and the WhatsApp/SMS outbox drains do not run in a read-only
  installation — invoicing automatically what the interface refuses to invoice would be
  incoherent. Stopping is safe because auto-billing's `monthsAfter` catch-up regenerates
  every skipped month on the first boot after renewal, leaving no gaps in the sequence.
  Two deliberate exceptions: delivery-status polls keep running (they reconcile messages
  already sent, and stopping them would strand those messages in an unknown state), and
  scheduled backups always run, for the same reason the backup routes are exempt from the
  HTTP gate.
- The job checks read the licence inside each tick rather than at registration, so
  activating a licence — or crossing midnight into expiry — takes effect without a
  restart.

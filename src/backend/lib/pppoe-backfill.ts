import type { Database } from 'better-sqlite3';
import { generatePppoePassword, pppoeUsernameFor } from './services';
import { sealPppoeSecret } from './secrets';

export type BackfillService = {
  serviceId: number;
  clientCode: string;
  clientName: string;
  status: string;
  clientStatus: string;
  username: string | null;
};

type Candidate = Pick<BackfillService, 'serviceId' | 'clientCode' | 'clientName'> & { username: string };
type Skipped = Omit<Candidate, 'username'> & {
  username: string | null;
  reason: 'nome já existe no router' | 'nome já usado no ISPM' | 'código sem número';
};
export type PppoeBackfillPlan = { create: Candidate[]; skipped: Skipped[] };
export type TakenPppoeNames = { router: ReadonlySet<string>; ispm: ReadonlySet<string>; routerServiceIds?: ReadonlySet<number> };

export function planPppoeBackfill(services: BackfillService[], takenNames: TakenPppoeNames, prefix: string): PppoeBackfillPlan {
  const create: Candidate[] = [];
  const skipped: Skipped[] = [];
  const planned = new Set<string>();
  for (const service of services) {
    if (service.status !== 'active' || service.clientStatus === 'cancelled' || service.username?.trim()) continue;
    const identity = { serviceId: service.serviceId, clientCode: service.clientCode, clientName: service.clientName };
    if (!/\d/.test(service.clientCode)) {
      skipped.push({ ...identity, username: null, reason: 'código sem número' });
      continue;
    }
    const username = pppoeUsernameFor({ prefix, clientCode: service.clientCode, clientName: service.clientName, serviceId: service.serviceId });
    if (takenNames.router.has(username) || takenNames.routerServiceIds?.has(service.serviceId)) {
      skipped.push({ ...identity, username, reason: 'nome já existe no router' });
    } else if (takenNames.ispm.has(username) || planned.has(username)) {
      skipped.push({ ...identity, username, reason: 'nome já usado no ISPM' });
    } else {
      create.push({ ...identity, username });
      planned.add(username);
    }
  }
  return { create, skipped };
}

export function applyPppoeBackfill(db: Database, plan: PppoeBackfillPlan): number {
  const update = db.prepare(`
    UPDATE services SET pppoe_username = ?, pppoe_password = ?, pppoe_password_sync_pending = 1,
      updated_at = datetime('now')
    WHERE id = ? AND (pppoe_username IS NULL OR TRIM(pppoe_username) = '')
  `);
  return db.transaction(() => {
    let applied = 0;
    for (const row of plan.create) {
      applied += update.run(row.username, sealPppoeSecret(generatePppoePassword()), row.serviceId).changes;
    }
    return applied;
  })();
}

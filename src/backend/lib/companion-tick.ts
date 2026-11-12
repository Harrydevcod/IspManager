import { licenseAllowsWrites } from './license';
import { runJob } from './jobRuns';
import { requestCompanionSnapshotPush, runCompanionSyncIfDue, type CompanionSyncResult } from './companion-sync';
import { pullCompanionEventsIfDue, type PullResult } from './companion-events';
import { pollSmsStatusIfDue, runSmsOutboxIfDue } from './sms-outbox';

/**
 * A troca completa com o telemóvel: estado + resumo, canal de volta e, quando
 * alguém o pediu (botão no desktop ou no telemóvel), a fila de SMS e os estados
 * dos pedidos já. Vive fora de companion-sync.ts porque companion-events já
 * importa de lá.
 */

export type CompanionTickResult = { sync: CompanionSyncResult; events: PullResult };

export type CompanionTickDeps = {
  sync: () => Promise<CompanionSyncResult>;
  pullEvents: () => Promise<PullResult>;
  drainSms: () => Promise<unknown>;
  pollSms: () => Promise<unknown>;
  canWrite: () => boolean;
};

const defaultDeps: CompanionTickDeps = {
  sync: () => runCompanionSyncIfDue(),
  pullEvents: () => runJob('companion_events', () => pullCompanionEventsIfDue()),
  drainSms: () => runJob('sms_drain', () => runSmsOutboxIfDue()),
  pollSms: () => runJob('sms_poll', () => pollSmsStatusIfDue()),
  canWrite: licenseAllowsWrites
};

let inFlight: Promise<CompanionTickResult> | null = null;

async function tick(force: boolean, deps: CompanionTickDeps): Promise<CompanionTickResult> {
  const sync = await deps.sync();
  const events = await deps.pullEvents();
  const requested = force || ('syncRequested' in sync && sync.syncRequested);
  if (requested) {
    if (deps.canWrite()) await deps.drainSms();
    await deps.pollSms();
  }
  return { sync, events };
}

/**
 * O tick de minuto a minuto (`force = false`) salta se outro ainda corre. O
 * "Sincronizar agora" (`force = true`) espera pelo que corre e faz o seu, com
 * o resumo marcado para sair: quem carregou recebe o resultado da sua troca.
 */
export async function runCompanionTick(force = false, deps: CompanionTickDeps = defaultDeps): Promise<CompanionTickResult | null> {
  if (!force && inFlight) return null;
  if (force) requestCompanionSnapshotPush();
  while (inFlight) await inFlight.catch(() => undefined);
  if (force) requestCompanionSnapshotPush(); // o tick que acabou pode ter acertado o relógio
  const run = tick(force, deps);
  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}

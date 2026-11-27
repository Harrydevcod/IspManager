import type Database from 'better-sqlite3';

/**
 * A causa de uma queda do backbone. Grava-se só a prova (o uptime voltou a zero?) e a escolha do
 * operador; a causa deriva-se ao ler, para que um "Vou reiniciar" ou um vizinho do mesmo local
 * registado depois mudem a leitura sem reescrever nada.
 */
export type OutageCause = 'planned' | 'reboot' | 'power' | 'link' | 'unknown';
export type OperatorCause = 'reboot' | 'power' | 'link';
export const OPERATOR_CAUSES: readonly OperatorCause[] = ['reboot', 'power', 'link'];

export type OutageCauseReading = {
  cause: OutageCause;
  source: 'auto' | 'operator' | null;
  /** O local do corte de energia, quando a causa é `power`. */
  siteName: string | null;
};

/** Minutos de folga de um "Vou reiniciar": o tempo de o operador carregar no botão e o fazer. */
export const PLANNED_REBOOT_MINUTES = 10;

/**
 * Tudo o que fica sem sinal quando `root` cai: os equipamentos cujos uplinks estão todos
 * dentro do conjunto. Um equipamento com outro uplink de pé não é arrastado.
 */
export function downstreamClosure(root: number, uplinks: Map<number, number[]>): Set<number> {
  const closure = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [device, ups] of uplinks) {
      if (!closure.has(device) && ups.length > 0 && ups.every((up) => closure.has(up))) {
        closure.add(device);
        grew = true;
      }
    }
  }
  return closure;
}

/** Os uplinks entre equipamentos não retirados. */
export function loadUplinks(db: Database.Database): Map<number, number[]> {
  const active = new Set((db.prepare("SELECT id FROM backbone_devices WHERE status <> 'retired'").all() as Array<{ id: number }>).map((row) => row.id));
  const uplinks = new Map<number, number[]>();
  for (const link of db.prepare('SELECT device_id AS deviceId, upstream_device_id AS upstreamId FROM backbone_links')
    .all() as Array<{ deviceId: number; upstreamId: number }>) {
    if (!active.has(link.deviceId) || !active.has(link.upstreamId)) continue;
    uplinks.set(link.deviceId, [...(uplinks.get(link.deviceId) ?? []), link.upstreamId]);
  }
  return uplinks;
}

/**
 * O equipamento arrancou depois da última vez que o vimos vivo? O uptime conta desde o arranque:
 * menor do que o tempo desde a última resposta = reiniciou (ou ficou sem energia) pelo meio.
 */
export function uptimeWasReset(uptimeSeconds: number, secondsSinceLastSeenAlive: number): boolean {
  return uptimeSeconds < secondsSinceLastSeenAlive;
}

/** A regra, sem base de dados: o programado manda, depois o operador, depois a prova. */
export function classifyOutage(input: {
  planned: boolean;
  operatorCause: OperatorCause | null;
  uptimeReset: boolean | null;
  siteMateFell: boolean;
}): Pick<OutageCauseReading, 'cause' | 'source'> {
  if (input.planned) return { cause: 'planned', source: 'operator' };
  if (input.operatorCause) return { cause: input.operatorCause, source: 'operator' };
  if (input.uptimeReset === null) return { cause: 'unknown', source: null };
  if (!input.uptimeReset) return { cause: 'link', source: 'auto' };
  return { cause: input.siteMateFell ? 'power' : 'reboot', source: 'auto' };
}

function toSql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function parseSql(at: string): number {
  return Date.parse(`${at.replace(' ', 'T')}Z`);
}

/** Um "Vou reiniciar" deste equipamento, ou de um de cima que o arrasta, cobre o início? */
export function isPlannedOutage(db: Database.Database, deviceId: number, startedAt: string, slackSeconds: number, uplinks = loadUplinks(db)): boolean {
  const windows = db.prepare('SELECT device_id AS deviceId, starts_at AS startsAt, until_at AS untilAt FROM planned_reboots WHERE starts_at <= ?')
    .all(startedAt) as Array<{ deviceId: number; startsAt: string; untilAt: string }>;
  const start = parseSql(startedAt);
  return windows.some((window) => start <= parseSql(window.untilAt) + slackSeconds * 1000 &&
    downstreamClosure(window.deviceId, uplinks).has(deviceId));
}

/**
 * Caiu outro equipamento do mesmo local, à mesma hora, sem um arrastar o outro? Dois rádios da
 * mesma torre que se apagam juntos sem dependerem um do outro partilham a mesma tomada.
 */
function siteMateFell(db: Database.Database, deviceId: number, startedAt: string, slackSeconds: number, uplinks: Map<number, number[]>): { fell: boolean; siteName: string | null } {
  const site = db.prepare(`
    SELECT s.id, s.name FROM backbone_devices d JOIN network_sites s ON s.id = d.site_id WHERE d.id = ?
  `).get(deviceId) as { id: number; name: string } | undefined;
  if (!site) return { fell: false, siteName: null };
  const start = parseSql(startedAt);
  const mates = db.prepare(`
    SELECT DISTINCT e.target_id AS id FROM network_probe_events e
    JOIN backbone_devices d ON d.id = e.target_id AND d.site_id = ?
    WHERE e.target_kind = 'backbone' AND e.to_state = 'down' AND e.target_id <> ? AND e.at BETWEEN ? AND ?
    UNION
    SELECT DISTINCT v.device_id AS id FROM network_outage_evidence v
    JOIN backbone_devices d ON d.id = v.device_id AND d.site_id = ?
    WHERE v.observed_down = 0 AND v.device_id <> ? AND v.started_at BETWEEN ? AND ?
  `).all(
    site.id, deviceId, toSql(start - slackSeconds * 1000), toSql(start + slackSeconds * 1000),
    site.id, deviceId, toSql(start - slackSeconds * 1000), toSql(start + slackSeconds * 1000)
  ) as Array<{ id: number }>;
  const mine = downstreamClosure(deviceId, uplinks);
  const fell = mates.some((mate) => !mine.has(mate.id) && !downstreamClosure(mate.id, uplinks).has(deviceId));
  return { fell, siteName: site.name };
}

/** A causa de uma queda (chave: equipamento + início), lida da prova gravada. */
export function readOutageCause(db: Database.Database, deviceId: number, startedAt: string, slackSeconds: number, uplinks = loadUplinks(db)): OutageCauseReading {
  const evidence = db.prepare(`
    SELECT uptime_reset AS uptimeReset, operator_cause AS operatorCause
    FROM network_outage_evidence WHERE device_id = ? AND started_at = ?
  `).get(deviceId, startedAt) as { uptimeReset: number | null; operatorCause: OperatorCause | null } | undefined;
  const planned = isPlannedOutage(db, deviceId, startedAt, slackSeconds, uplinks);
  const reset = evidence?.uptimeReset === null || evidence?.uptimeReset === undefined ? null : evidence.uptimeReset === 1;
  const mate = reset ? siteMateFell(db, deviceId, startedAt, slackSeconds, uplinks) : { fell: false, siteName: null };
  const decided = classifyOutage({ planned, operatorCause: evidence?.operatorCause ?? null, uptimeReset: reset, siteMateFell: mate.fell });
  const siteName = decided.cause === 'power'
    ? mate.siteName ?? (db.prepare('SELECT s.name FROM backbone_devices d JOIN network_sites s ON s.id = d.site_id WHERE d.id = ?').get(deviceId) as { name: string } | undefined)?.name ?? null
    : null;
  return { ...decided, siteName };
}

/** Grava a prova do uptime de uma queda, sem tocar na escolha do operador. */
export function recordOutageEvidence(db: Database.Database, deviceId: number, startedAt: string, uptimeReset: boolean | null, observedDown = true): void {
  db.prepare(`
    INSERT INTO network_outage_evidence (device_id, started_at, uptime_reset, observed_down)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, started_at) DO UPDATE SET uptime_reset = excluded.uptime_reset
  `).run(deviceId, startedAt, uptimeReset === null ? null : uptimeReset ? 1 : 0, observedDown ? 1 : 0);
}

/** A causa escolhida à mão; `null` devolve a decisão à prova automática. */
export function setOperatorCause(db: Database.Database, deviceId: number, startedAt: string, cause: OperatorCause | null, userId: number | null): void {
  db.prepare(`
    INSERT INTO network_outage_evidence (device_id, started_at, operator_cause, decided_by, decided_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device_id, started_at) DO UPDATE SET
      operator_cause = excluded.operator_cause, decided_by = excluded.decided_by, decided_at = excluded.decided_at
  `).run(deviceId, startedAt, cause, userId);
}

/** "Vou reiniciar": abre a janela a partir de agora. */
export function startPlannedReboot(db: Database.Database, deviceId: number, userId: number | null, nowMs = Date.now()): { startsAt: string; untilAt: string } {
  const startsAt = toSql(nowMs);
  const untilAt = toSql(nowMs + PLANNED_REBOOT_MINUTES * 60_000);
  db.prepare('INSERT INTO planned_reboots (device_id, starts_at, until_at, created_by) VALUES (?, ?, ?, ?)').run(deviceId, startsAt, untilAt, userId);
  return { startsAt, untilAt };
}

/** Cancelar fecha a janela agora; o que já caiu dentro dela continua programado. */
export function cancelPlannedReboot(db: Database.Database, deviceId: number, nowMs = Date.now()): void {
  db.prepare('UPDATE planned_reboots SET until_at = ? WHERE device_id = ? AND until_at > ?').run(toSql(nowMs), deviceId, toSql(nowMs));
}

/** Os equipamentos com um "Vou reiniciar" ainda aberto, e até quando. */
export function activePlannedReboots(db: Database.Database, nowMs = Date.now()): Map<number, string> {
  const rows = db.prepare('SELECT device_id AS deviceId, MAX(until_at) AS untilAt FROM planned_reboots WHERE starts_at <= ? AND until_at > ? GROUP BY device_id')
    .all(toSql(nowMs), toSql(nowMs)) as Array<{ deviceId: number; untilAt: string }>;
  return new Map(rows.map((row) => [row.deviceId, row.untilAt]));
}

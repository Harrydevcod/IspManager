import { execFile } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';

export type ProbeState = 'up' | 'down';
export type ProbeTargetKind = 'backbone' | 'assignment';

export type PingResult = { ok: boolean; rttMs: number | null };
export type Pinger = (ip: string, timeoutMs: number) => Promise<PingResult>;

export type ProbeTarget = {
  kind: ProbeTargetKind;
  id: number;
  name: string;
  ipAddress: string;
};

export type ProbeStateRow = {
  targetKind: ProbeTargetKind;
  targetId: number;
  ipAddress: string;
  state: ProbeState;
  rttMs: number | null;
  consecutiveFails: number;
  lastOkAt: string | null;
  lastChangeAt: string;
  checkedAt: string;
};

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_FAIL_THRESHOLD = 3;
const DEFAULT_INTERVAL_SECONDS = 60;
// ponytail: 8 pings em voo chega para umas centenas de equipamentos numa LAN;
// sobe se um dia a sonda demorar mais do que o próprio intervalo.
const MAX_CONCURRENCY = 8;

// ---------------------------------------------------------------- definições

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

function numberSetting(db: Database.Database, key: string, fallback: number, min: number, max: number): number {
  const n = Number(getSetting(db, key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
}

function boolSetting(db: Database.Database, key: string): boolean {
  return getSetting(db, key) === 'true';
}

export type ProbeConfig = {
  enabled: boolean;
  intervalSeconds: number;
  includeClients: boolean;
  failThreshold: number;
};

export function readProbeConfig(db: Database.Database): ProbeConfig {
  return {
    enabled: boolSetting(db, 'networkProbeEnabled'),
    intervalSeconds: numberSetting(db, 'networkProbeIntervalSeconds', DEFAULT_INTERVAL_SECONDS, 30, 3600),
    includeClients: boolSetting(db, 'networkProbeIncludeClients'),
    failThreshold: numberSetting(db, 'networkProbeFailThreshold', DEFAULT_FAIL_THRESHOLD, 1, 10)
  };
}

/** Lido a cada tick pelo agendador, para o intervalo mudar sem reiniciar. */
export function networkProbeIntervalMs(): number {
  return readProbeConfig(getSqliteDatabase()).intervalSeconds * 1000;
}

// -------------------------------------------------------------------- sonda

/**
 * Ping pelo binário do sistema. Um socket ICMP em Node exigiria raw sockets e
 * correr como administrador — inaceitável num desktop; o `ping` do sistema não
 * exige nada e existe em Windows, macOS e Linux.
 */
export const systemPing: Pinger = (ip, timeoutMs) => new Promise((resolve) => {
  const windows = process.platform === 'win32';
  const args = windows
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), ip];
  execFile('ping', args, { timeout: timeoutMs + 1000, windowsHide: true }, (error, stdout) => {
    resolve(parsePingOutput(stdout ?? '', error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0));
  });
});

/**
 * O código de saída não chega: em Windows o `ping` devolve 0 mesmo com "Host de
 * destino inacessível" ou "Esgotou-se o tempo limite". Uma resposta a sério traz
 * sempre o TTL, e é isso que se procura.
 */
export function parsePingOutput(stdout: string, exitCode: number | string): PingResult {
  const text = stdout.toLowerCase();
  const alive = /ttl[=:]/.test(text) && exitCode === 0;
  if (!alive) return { ok: false, rttMs: null };
  const match = text.match(/(?:time|tempo)[=<]\s*([\d.,]+)\s*ms/);
  const rtt = match ? Number(match[1].replace(',', '.')) : NaN;
  return { ok: true, rttMs: Number.isFinite(rtt) ? Math.round(rtt) : null };
}

/**
 * Máquina de estados de um alvo. Só declara `down` ao fim de `failThreshold`
 * falhas seguidas — um ping perdido numa ligação rádio é normal e não é avaria;
 * a subida é imediata, porque quem voltou, voltou.
 */
export function decideProbeTransition(
  previous: Pick<ProbeStateRow, 'state' | 'consecutiveFails'> | null,
  result: PingResult,
  failThreshold: number
): { state: ProbeState; changed: boolean; consecutiveFails: number } {
  if (result.ok) {
    return { state: 'up', changed: previous?.state !== 'up', consecutiveFails: 0 };
  }
  const fails = (previous?.consecutiveFails ?? 0) + 1;
  const down = fails >= failThreshold;
  const state: ProbeState = down ? 'down' : previous?.state ?? 'up';
  return { state, changed: down && previous?.state !== 'down', consecutiveFails: fails };
}

// ------------------------------------------------------------------- alvos

export function loadProbeTargets(db: Database.Database, includeClients: boolean): ProbeTarget[] {
  const backbones = db.prepare(`
    SELECT id, name, ip_address AS ipAddress
    FROM backbone_devices
    WHERE status IN ('active','maintenance')
      AND ip_address IS NOT NULL AND TRIM(ip_address) <> ''
    ORDER BY name
  `).all() as Array<{ id: number; name: string; ipAddress: string }>;

  const targets: ProbeTarget[] = backbones.map((row) => ({ kind: 'backbone', id: row.id, name: row.name, ipAddress: row.ipAddress }));
  if (!includeClients) return targets;

  const assignments = db.prepare(`
    SELECT a.id, c.full_name AS name, a.ip_address AS ipAddress
    FROM service_device_assignments a
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    WHERE a.end_date IS NULL
      AND s.status = 'active'
      AND a.ip_address IS NOT NULL AND TRIM(a.ip_address) <> ''
    ORDER BY c.full_name
  `).all() as Array<{ id: number; name: string; ipAddress: string }>;

  for (const row of assignments) {
    targets.push({ kind: 'assignment', id: row.id, name: row.name, ipAddress: row.ipAddress });
  }
  return targets;
}

export function loadProbeStates(db: Database.Database): ProbeStateRow[] {
  return db.prepare(`
    SELECT target_kind AS targetKind, target_id AS targetId, ip_address AS ipAddress, state,
           rtt_ms AS rttMs, consecutive_fails AS consecutiveFails, last_ok_at AS lastOkAt,
           last_change_at AS lastChangeAt, checked_at AS checkedAt
    FROM network_probe_state
  `).all() as ProbeStateRow[];
}

// ---------------------------------------------------------------- execução

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function secondsBetween(from: string, to: string): number {
  const start = Date.parse(`${from.replace(' ', 'T')}Z`);
  const end = Date.parse(`${to.replace(' ', 'T')}Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function sqlNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export type ProbeRunSummary = {
  skipped?: boolean;
  reason?: string;
  checked: number;
  up: number;
  down: number;
  transitions: number;
};

/** Sonda todos os alvos uma vez e persiste estado + transições. */
export async function runNetworkProbe(
  db: Database.Database,
  options: { includeClients: boolean; failThreshold: number; ping?: Pinger; timeoutMs?: number }
): Promise<ProbeRunSummary> {
  const ping = options.ping ?? systemPing;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targets = loadProbeTargets(db, options.includeClients);
  if (targets.length === 0) {
    return { skipped: true, reason: 'sem equipamentos com IP', checked: 0, up: 0, down: 0, transitions: 0 };
  }

  const previousRows = loadProbeStates(db);
  const previousByKey = new Map(previousRows.map((row) => [`${row.targetKind}:${row.targetId}`, row]));
  const results = await mapWithLimit(targets, MAX_CONCURRENCY, (target) => ping(target.ipAddress, timeoutMs));

  const now = sqlNow();
  const upsert = db.prepare(`
    INSERT INTO network_probe_state
      (target_kind, target_id, ip_address, state, rtt_ms, consecutive_fails, last_ok_at, last_change_at, checked_at)
    VALUES (@targetKind, @targetId, @ipAddress, @state, @rttMs, @consecutiveFails, @lastOkAt, @lastChangeAt, @checkedAt)
    ON CONFLICT(target_kind, target_id) DO UPDATE SET
      ip_address = excluded.ip_address,
      state = excluded.state,
      rtt_ms = excluded.rtt_ms,
      consecutive_fails = excluded.consecutive_fails,
      last_ok_at = excluded.last_ok_at,
      last_change_at = excluded.last_change_at,
      checked_at = excluded.checked_at
  `);
  const insertEvent = db.prepare(`
    INSERT INTO network_probe_events (target_kind, target_id, ip_address, from_state, to_state, at, duration_seconds, gap_before)
    VALUES (@targetKind, @targetId, @ipAddress, @fromState, @toState, @at, @durationSeconds, @gapBefore)
  `);
  const gapLimitSeconds = readProbeConfig(db).intervalSeconds * 3;

  const summary: ProbeRunSummary = { checked: targets.length, up: 0, down: 0, transitions: 0 };

  db.transaction(() => {
    targets.forEach((target, index) => {
      const previous = previousByKey.get(`${target.kind}:${target.id}`) ?? null;
      const result = results[index];
      const decision = decideProbeTransition(previous, result, options.failThreshold);
      if (decision.state === 'up') summary.up += 1; else summary.down += 1;

      upsert.run({
        targetKind: target.kind,
        targetId: target.id,
        ipAddress: target.ipAddress,
        state: decision.state,
        rttMs: result.rttMs,
        consecutiveFails: decision.consecutiveFails,
        lastOkAt: result.ok ? now : previous?.lastOkAt ?? null,
        lastChangeAt: decision.changed ? now : previous?.lastChangeAt ?? now,
        checkedAt: now
      });

      // Buraco de observação: a aplicação esteve fechada mais tempo do que a
      // sonda tolera. Marca-se, porque esse tempo não é rede de pé nem em baixo.
      const gapBefore = previous ? secondsBetween(previous.checkedAt, now) > gapLimitSeconds : false;

      // A primeira observação de um equipamento vivo não é transição: só se
      // regista o que muda depois de já se conhecer o estado anterior — ou a
      // retoma depois de um buraco, que fecha a janela por observar.
      if ((decision.changed && (previous || decision.state === 'down')) || gapBefore) {
        insertEvent.run({
          targetKind: target.kind,
          targetId: target.id,
          ipAddress: target.ipAddress,
          fromState: previous?.state ?? null,
          toState: decision.state,
          at: now,
          durationSeconds: previous && !gapBefore ? secondsBetween(previous.lastChangeAt, now) : null,
          gapBefore: gapBefore ? 1 : 0
        });
        if (decision.changed) summary.transitions += 1;
      }
    });
  })();

  return summary;
}

/** Wrapper para o agendador: respeita a definição de ligado/desligado. */
export async function runNetworkProbeIfDue(): Promise<ProbeRunSummary> {
  const db = getSqliteDatabase();
  const config = readProbeConfig(db);
  if (!config.enabled) {
    return { skipped: true, reason: 'sonda desligada', checked: 0, up: 0, down: 0, transitions: 0 };
  }
  return runNetworkProbe(db, { includeClients: config.includeClients, failThreshold: config.failThreshold });
}

// ------------------------------------------------------------ leitura de estado

export type NetworkTargetStatus = {
  kind: ProbeTargetKind;
  id: number;
  name: string;
  ipAddress: string;
  state: ProbeState;
  rttMs: number | null;
  /** Desde quando está no estado atual. */
  since: string;
  lastOkAt: string | null;
  checkedAt: string;
  /** Disponibilidade no período observado, 0–1. */
  uptime: number;
  observedSeconds: number;
};

export type NetworkStatus = {
  enabled: boolean;
  intervalSeconds: number;
  includeClients: boolean;
  /** Última vez que a sonda correu, de todas as leituras. */
  lastRunAt: string | null;
  targets: NetworkTargetStatus[];
  downCount: number;
  /** Alvos com IP que a sonda ainda nunca leu (acabados de registar). */
  neverProbed: number;
  windowDays: number;
};

export function loadProbeEvents(
  db: Database.Database,
  windowStart: string,
  target?: { kind: ProbeTargetKind; id: number }
): Array<UptimeEvent & { kind: ProbeTargetKind; id: number; durationSeconds: number | null }> {
  const where = target ? 'WHERE at >= ? AND target_kind = ? AND target_id = ?' : 'WHERE at >= ?';
  const params = target ? [windowStart, target.kind, target.id] : [windowStart];
  const rows = db.prepare(`
    SELECT target_kind AS kind, target_id AS id, from_state AS fromState, to_state AS toState,
           at, duration_seconds AS durationSeconds, gap_before AS gapBefore
    FROM network_probe_events
    ${where}
    ORDER BY at
  `).all(...params) as Array<{
    kind: ProbeTargetKind; id: number; fromState: ProbeState | null; toState: ProbeState;
    at: string; durationSeconds: number | null; gapBefore: number;
  }>;
  return rows.map((row) => ({ ...row, gapBefore: row.gapBefore === 1 }));
}

export function loadNetworkStatus(db: Database.Database, windowDays = 30): NetworkStatus {
  const config = readProbeConfig(db);
  const now = sqlNow();
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

  // Mostra-se tudo o que foi lido, mesmo o que a definição já não sonda: uma
  // leitura feita não desaparece do painel só porque se desligou a opção. A
  // definição decide o que a sonda toca, não o que se sabe.
  const known = loadProbeTargets(db, true);
  const configured = config.includeClients ? known : known.filter((target) => target.kind === 'backbone');
  const states = new Map(loadProbeStates(db).map((row) => [`${row.targetKind}:${row.targetId}`, row]));
  const events = loadProbeEvents(db, windowStart);

  const result: NetworkTargetStatus[] = [];
  for (const target of known) {
    const state = states.get(`${target.kind}:${target.id}`);
    if (!state) continue;
    const mine = events.filter((event) => event.kind === target.kind && event.id === target.id);
    const uptime = computeUptime({
      events: mine,
      currentState: state.state,
      windowStart,
      now,
      lastCheckedAt: state.checkedAt,
      intervalSeconds: config.intervalSeconds
    });
    result.push({
      kind: target.kind,
      id: target.id,
      name: target.name,
      ipAddress: target.ipAddress,
      state: state.state,
      rttMs: state.rttMs,
      since: state.lastChangeAt,
      lastOkAt: state.lastOkAt,
      checkedAt: state.checkedAt,
      uptime: uptime.uptime,
      observedSeconds: uptime.observedSeconds
    });
  }

  const lastRunAt = result.reduce<string | null>(
    (latest, item) => (latest === null || item.checkedAt > latest ? item.checkedAt : latest),
    null
  );

  return {
    enabled: config.enabled,
    intervalSeconds: config.intervalSeconds,
    includeClients: config.includeClients,
    lastRunAt,
    targets: result,
    downCount: result.filter((item) => item.state === 'down').length,
    // Por sondar é só o que a sonda devia ler e ainda não leu.
    neverProbed: configured.filter((target) => !states.has(`${target.kind}:${target.id}`)).length,
    windowDays
  };
}

// -------------------------------------------------------------- disponibilidade

export type UptimeEvent = { fromState: ProbeState | null; toState: ProbeState; at: string; gapBefore?: boolean };

export type UptimeInput = {
  /** Transições e retomas dentro da janela, por ordem qualquer. */
  events: UptimeEvent[];
  /** Estado atual, para fechar a última janela até agora. */
  currentState: ProbeState;
  windowStart: string;
  now: string;
  /** Última observação registada: depois dela, o tempo deixa de ser observado. */
  lastCheckedAt: string;
  /** Intervalo configurado da sonda, para medir buracos de observação. */
  intervalSeconds: number;
};

/**
 * Disponibilidade sobre o tempo *observado*, não sobre o calendário.
 *
 * ponytail: a sonda só vê a rede enquanto o ISPM está aberto. O tempo em que
 * ninguém observou — antes da primeira leitura, depois da última, e as retomas
 * marcadas com `gapBefore` — não conta para nenhum dos lados; contá-lo como rede
 * de pé seria mentir para cima. Se um dia for preciso 24/7, o caminho é um agente
 * residente, não mexer nesta conta.
 */
export function computeUptime(input: UptimeInput): { uptime: number; observedSeconds: number; downSeconds: number } {
  const gapLimit = input.intervalSeconds * 3;
  const ordered = [...input.events].sort((a, b) => a.at.localeCompare(b.at));
  let observed = 0;
  let down = 0;

  const account = (from: string, to: string, state: ProbeState | null, counted: boolean) => {
    if (!counted || state === null) return;
    const seconds = secondsBetween(from, to);
    if (seconds <= 0) return;
    observed += seconds;
    if (state === 'down') down += seconds;
  };

  let cursor = input.windowStart;
  // Antes do primeiro evento o estado é o `fromState` desse evento; sem eventos,
  // é o estado atual. Um `fromState` nulo é a primeira observação de sempre —
  // antes dela não há nada observado.
  let stateAtCursor: ProbeState | null = ordered.length > 0 ? ordered[0].fromState : input.currentState;

  for (const event of ordered) {
    account(cursor, event.at, stateAtCursor, !event.gapBefore);
    cursor = event.at;
    stateAtCursor = event.toState;
  }

  // A cauda só conta até à última leitura; se a sonda parou há mais do que o
  // limite, o resto da janela ficou por observar.
  const tailEnd = secondsBetween(input.lastCheckedAt, input.now) > gapLimit ? input.lastCheckedAt : input.now;
  account(cursor, tailEnd, stateAtCursor, true);

  return {
    uptime: observed > 0 ? (observed - down) / observed : 1,
    observedSeconds: observed,
    downSeconds: down
  };
}

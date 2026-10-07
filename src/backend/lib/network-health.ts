import type Database from 'better-sqlite3';
import { readProbeConfig } from './network-probe';
import { DHCP_CHURN_THRESHOLD } from './routeros';
import type { FindingKind } from './router-log-watch';

export type HealthTone = 'ok' | 'warn' | 'danger';
export type HealthOutage = { id: number; name: string; ipAddress: string; downs: number; downSeconds: number; longestSeconds: number };
export type HealthDown = { kind: 'backbone' | 'assignment'; id: number; name: string; ipAddress: string; since: string };
export type HealthFinding = {
  kind: FindingKind; subject: string; label: string; count: number; firstAt: string; lastAt: string;
  /** O equipamento do backbone com esse IP, quando o achado é uma queda vista pelo router. */
  deviceName: string | null;
  clientName: string | null;
  vendor: string | null;
};
export type DiaryStatus = 'aberta' | 'resolvida';
export type DiaryEntry = {
  id: number; happenedAt: string; title: string; cause: string; resolution: string; status: DiaryStatus; createdAt: string; updatedAt: string;
};
export type NetworkHealth = {
  hours: number;
  tone: HealthTone;
  probeEnabled: boolean;
  /** Última passagem da sonda (UTC) e última leitura do registo do router: até onde se viu. */
  lastProbeAt: string | null;
  lastRouterReadAt: string | null;
  antennas: HealthOutage[];
  clients: HealthOutage[];
  downNow: HealthDown[];
  findings: HealthFinding[];
  diary: DiaryEntry[];
};

// Do mais grave para o menos: é a ordem em que o painel os mostra.
const SEVERITY: FindingKind[] = ['ip_duplicado', 'antena_em_baixo', 'dhcp_intruso', 'pppoe_queda', 'dhcp_ciclo', 'login_falhado'];
const MAC_KINDS: FindingKind[] = ['ip_duplicado', 'dhcp_intruso', 'dhcp_ciclo'];

const pad = (value: number) => String(value).padStart(2, '0');
const utcSql = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
/** A hora local, no formato em que o router a escreve no registo. */
const localSql = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/** A quem pertence um MAC e quem o fabricou, pelo que o registo e a Descoberta sabem. */
export function macLookup(db: Database.Database) {
  const clientOfMac = db.prepare(`
    SELECT c.full_name AS name FROM service_device_assignments a
    JOIN services s ON s.id = a.service_id JOIN clients c ON c.id = s.client_id
    WHERE upper(a.mac_address) = ? AND a.end_date IS NULL LIMIT 1
  `);
  const vendorOfMac = db.prepare(`
    SELECT vendor FROM network_discovery_hosts WHERE upper(mac_address) = ? ORDER BY last_seen_at DESC LIMIT 1
  `);
  return (mac: string) => ({
    clientName: (clientOfMac.get(mac) as { name: string } | undefined)?.name ?? null,
    vendor: (vendorOfMac.get(mac) as { vendor: string | null } | undefined)?.vendor ?? null
  });
}

export function loginLookup(db: Database.Database) {
  const clientOfLogin = db.prepare('SELECT c.full_name AS name FROM services s JOIN clients c ON c.id = s.client_id WHERE s.pppoe_username = ? LIMIT 1');
  return (login: string) => (clientOfLogin.get(login) as { name: string } | undefined)?.name ?? null;
}

/**
 * O estado da rede nas últimas `hours` horas, do que a sonda e o vigia do registo já gravaram.
 *
 * ponytail: só se vê o que aconteceu com o ISPM aberto — `lastProbeAt` e `lastRouterReadAt`
 * dizem até onde. Os achados do router são somas diárias, por isso a janela deles arredonda
 * ao dia; e estão na hora local do router, que se assume ser a desta máquina.
 */
export function loadNetworkHealth(db: Database.Database, hours = 72, now = new Date()): NetworkHealth {
  const windowStart = utcSql(new Date(now.getTime() - hours * 3_600_000));

  // A duração gravada num regresso é o tempo que esteve em baixo; uma queda ainda aberta não soma.
  const outages = (kind: 'backbone' | 'assignment', names: string) => db.prepare(`
    SELECT e.target_id AS id, t.name, t.ipAddress,
           SUM(e.to_state = 'down') AS downs,
           COALESCE(SUM(CASE WHEN e.to_state = 'up' AND e.from_state = 'down' THEN e.duration_seconds END), 0) AS downSeconds,
           COALESCE(MAX(CASE WHEN e.to_state = 'up' AND e.from_state = 'down' THEN e.duration_seconds END), 0) AS longestSeconds
    FROM network_probe_events e JOIN (${names}) t ON t.id = e.target_id
    WHERE e.target_kind = ? AND e.gap_before = 0 AND e.at >= ?
    GROUP BY e.target_id HAVING downs > 0
    ORDER BY downSeconds DESC, downs DESC
  `).all(kind, windowStart) as HealthOutage[];

  const BACKBONE_NAMES = "SELECT id, name, COALESCE(ip_address, '') AS ipAddress FROM backbone_devices WHERE status <> 'retired'";
  const CLIENT_NAMES = `SELECT a.id, c.full_name AS name, COALESCE(a.ip_address, '') AS ipAddress
    FROM service_device_assignments a JOIN services s ON s.id = a.service_id JOIN clients c ON c.id = s.client_id`;
  const antennas = outages('backbone', BACKBONE_NAMES);
  const clients = outages('assignment', CLIENT_NAMES).slice(0, 6);

  const lastProbeAt = (db.prepare('SELECT MAX(checked_at) AS at FROM network_probe_state').get() as { at: string | null }).at;
  // Quem deixou de ser sondado fica com uma linha `down` antiga: só vale a última passagem.
  const downNow = lastProbeAt === null ? [] : db.prepare(`
    SELECT p.target_kind AS kind, p.target_id AS id, COALESCE(b.name, c.name) AS name, p.ip_address AS ipAddress, p.last_change_at AS since
    FROM network_probe_state p
    LEFT JOIN (${BACKBONE_NAMES}) b ON p.target_kind = 'backbone' AND b.id = p.target_id
    LEFT JOIN (${CLIENT_NAMES}) c ON p.target_kind = 'assignment' AND c.id = p.target_id
    WHERE p.state = 'down' AND p.checked_at >= datetime(?, '-10 minutes') AND COALESCE(b.name, c.name) IS NOT NULL
    ORDER BY p.target_kind DESC, p.last_change_at
  `).all(lastProbeAt) as HealthDown[];

  const aboutMac = macLookup(db);
  const clientOfLogin = loginLookup(db);
  const deviceOfIp = db.prepare(`SELECT name FROM (${BACKBONE_NAMES}) WHERE ipAddress = ? LIMIT 1`);
  const clientOfIp = db.prepare(`SELECT name FROM (${CLIENT_NAMES}) WHERE ipAddress = ? LIMIT 1`);
  const findings = (db.prepare(`
    SELECT kind, subject, MAX(label) AS label, SUM(count) AS count, MIN(first_at) AS firstAt, MAX(last_at) AS lastAt
    FROM router_log_findings WHERE last_at >= ? GROUP BY kind, subject
  `).all(localSql(new Date(now.getTime() - hours * 3_600_000))) as Array<Omit<HealthFinding, 'deviceName' | 'clientName' | 'vendor'>>)
    .filter((row) => row.kind !== 'dhcp_ciclo' || row.count >= DHCP_CHURN_THRESHOLD)
    .map((row): HealthFinding => {
      const name = (statement: Database.Statement) => (statement.get(row.subject) as { name: string } | undefined)?.name ?? null;
      if (MAC_KINDS.includes(row.kind)) return { ...row, deviceName: null, ...aboutMac(row.subject) };
      if (row.kind === 'pppoe_queda') return { ...row, deviceName: null, clientName: clientOfLogin(row.subject), vendor: null };
      if (row.kind === 'antena_em_baixo') return { ...row, deviceName: name(deviceOfIp), clientName: name(clientOfIp), vendor: null };
      return { ...row, deviceName: null, clientName: null, vendor: null };
    })
    .sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind) || b.count - a.count);

  const dayAgo = localSql(new Date(now.getTime() - 24 * 3_600_000));
  const tone: HealthTone = downNow.some((row) => row.kind === 'backbone') || findings.some((row) => row.kind === 'ip_duplicado' && row.lastAt >= dayAgo)
    ? 'danger'
    : antennas.length > 0 || findings.some((row) => ['ip_duplicado', 'antena_em_baixo', 'dhcp_intruso'].includes(row.kind)) ? 'warn' : 'ok';

  return {
    hours,
    tone,
    probeEnabled: readProbeConfig(db).enabled,
    lastProbeAt,
    lastRouterReadAt: (db.prepare("SELECT value FROM app_settings WHERE key = 'routerLogReadAt'").get() as { value: string } | undefined)?.value ?? null,
    antennas,
    clients,
    downNow,
    findings,
    diary: listDiary(db).slice(0, 6)
  };
}

// ------------------------------------------------------------------- diário

const DIARY_COLUMNS = `id, happened_at AS happenedAt, title, cause, resolution, status, created_at AS createdAt, updated_at AS updatedAt`;

/** As ocorrências escritas pelo operador: abertas primeiro, depois as mais recentes. */
export function listDiary(db: Database.Database): DiaryEntry[] {
  return db.prepare(`SELECT ${DIARY_COLUMNS} FROM network_diary ORDER BY (status = 'aberta') DESC, happened_at DESC, id DESC`).all() as DiaryEntry[];
}

const getDiaryEntry = (db: Database.Database, id: number) =>
  (db.prepare(`SELECT ${DIARY_COLUMNS} FROM network_diary WHERE id = ?`).get(id) as DiaryEntry | undefined) ?? null;

export type DiaryInput = { happenedAt: string; title: string; cause?: string; resolution?: string; status?: DiaryStatus };

export function createDiaryEntry(db: Database.Database, input: DiaryInput, userId: number | null): DiaryEntry {
  const id = Number(db.prepare('INSERT INTO network_diary (happened_at, title, cause, resolution, status, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.happenedAt, input.title, input.cause ?? '', input.resolution ?? '', input.status ?? 'aberta', userId).lastInsertRowid);
  return getDiaryEntry(db, id)!;
}

/** Só muda o que vier no pedido. Uma ocorrência fecha-se; não se apaga. */
export function updateDiaryEntry(db: Database.Database, id: number, patch: Partial<DiaryInput>): DiaryEntry | null {
  const current = getDiaryEntry(db, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  db.prepare(`UPDATE network_diary SET happened_at = ?, title = ?, cause = ?, resolution = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.happenedAt, next.title, next.cause, next.resolution, next.status, id);
  return getDiaryEntry(db, id);
}

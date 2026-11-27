import type Database from 'better-sqlite3';
import { loadProbeEvents, loadProbeStates, readProbeConfig, secondsBetween, sqlNow } from './network-probe';
import { loadDishIncidents } from './starlink-dish';
import { downstreamClosure, loadUplinks, readOutageCause, type OutageCause } from './outage-cause';

export type IncidentStatus = 'open' | 'resolved' | 'unknown';

export type IncidentClient = { clientId: number; clientCode: string; clientName: string; zone: string | null };

export type NetworkIncident = {
  key: string;
  /** `null` num corte da antena Starlink: cai a saída de toda a rede, não um equipamento do backbone. */
  backboneDeviceId: number | null;
  name: string;
  zone: string | null;
  status: IncidentStatus;
  startedAt: string;
  /** Regresso observado; num incidente `unknown` é só a primeira leitura depois do buraco. */
  endedAt: string | null;
  /** Até agora num incidente aberto; nulo quando o fim não foi observado. */
  durationSeconds: number | null;
  /** Equipamentos que só recebem sinal através deste. */
  draggedDevices: string[];
  clients: IncidentClient[];
  /** A causa que a antena Starlink deu ao corte; `null` nas quedas do backbone. */
  cause: string | null;
  /** Reinício, energia, ligação: lida da prova do uptime e da escolha do operador; `null` na Starlink. */
  outageCause: OutageCause | null;
  causeSource: 'auto' | 'operator' | null;
  /** O local do corte de energia. */
  siteName: string | null;
  /** Reinício tão curto que a sonda nem deu a queda: só o uptime o mostrou. */
  observedDown: boolean;
};

type Outage = { deviceId: number; startedAt: string; endedAt: string | null; status: IncidentStatus; observedDown?: boolean };

export { downstreamClosure };

/** Os clientes com serviço ativo pendurados diretamente num equipamento do backbone. */
const CLIENTS_OF_DEVICE_SQL = `
  SELECT DISTINCT c.id AS clientId, c.client_code AS clientCode, c.full_name AS clientName, c.zone
  FROM backbone_assignment_links bal
  JOIN service_device_assignments a ON a.id = bal.assignment_id AND a.end_date IS NULL
  JOIN assignment_services asv ON asv.assignment_id = a.id
  JOIN services s ON s.id = asv.service_id AND s.status = 'active'
  JOIN clients c ON c.id = s.client_id
  WHERE bal.ended_at IS NULL AND bal.backbone_device_id = ?
`;

/**
 * Quem fica sem sinal se `deviceId` parar (uma manutenção numa torre): os clientes dele e dos
 * equipamentos que só recebem sinal através dele.
 */
export function clientsDownstreamOf(db: Database.Database, deviceId: number): IncidentClient[] {
  const uplinks = loadUplinks(db);
  const clientsOf = db.prepare(CLIENTS_OF_DEVICE_SQL);
  const clients = new Map<number, IncidentClient>();
  for (const id of downstreamClosure(deviceId, uplinks)) for (const row of clientsOf.all(id) as IncidentClient[]) clients.set(row.clientId, row);
  return [...clients.values()].sort((a, b) => a.clientCode.localeCompare(b.clientCode));
}

/**
 * Os incidentes do backbone, derivados das transições que a sonda já grava: não há tabela
 * própria. Só as causas são devolvidas; o que caiu por arrasto entra em `draggedDevices`.
 *
 * ponytail: os afetados e os arrastados contam-se pela topologia de hoje — um incidente
 * antigo mostra quem pende do equipamento agora. Gravar a contagem na queda se o histórico
 * tiver de ficar congelado.
 */
export function loadIncidents(db: Database.Database, windowDays = 30, now = sqlNow()) {
  const config = readProbeConfig(db);
  const windowStart = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - windowDays * 86_400_000)
    .toISOString().slice(0, 19).replace('T', ' ');

  const devices = new Map((db.prepare("SELECT id, name, zone FROM backbone_devices WHERE status <> 'retired'")
    .all() as Array<{ id: number; name: string; zone: string | null }>).map((row) => [row.id, row]));
  const uplinks = loadUplinks(db);
  const stillDown = new Set(loadProbeStates(db)
    .filter((row) => row.targetKind === 'backbone' && row.state === 'down').map((row) => row.targetId));

  // Todos os eventos, não só os da janela: uma queda anterior à janela pode ainda estar aberta.
  const open = new Map<number, Outage>();
  const outages: Outage[] = [];
  for (const event of loadProbeEvents(db, '')) {
    if (event.kind !== 'backbone' || !devices.has(event.id)) continue;
    const current = open.get(event.id);
    if (event.toState === 'down' && !current) {
      const outage: Outage = { deviceId: event.id, startedAt: event.at, endedAt: null, status: 'open' };
      open.set(event.id, outage);
      outages.push(outage);
    } else if (event.toState === 'up' && current) {
      // Regresso depois de um buraco de observação: voltou algures com a aplicação fechada.
      current.endedAt = event.at;
      current.status = event.gapBefore ? 'unknown' : 'resolved';
      open.delete(event.id);
    }
  }
  // Sem regresso gravado mas a sonda já não o dá como em baixo (deixou de ser sondado).
  for (const outage of open.values()) if (!stillDown.has(outage.deviceId)) outage.status = 'unknown';
  // Reinícios que só o uptime viu: a sonda nem chegou a dar a queda.
  for (const row of db.prepare('SELECT device_id AS deviceId, started_at AS startedAt FROM network_outage_evidence WHERE observed_down = 0')
    .all() as Array<{ deviceId: number; startedAt: string }>) {
    if (devices.has(row.deviceId)) outages.push({ deviceId: row.deviceId, startedAt: row.startedAt, endedAt: row.startedAt, status: 'resolved', observedDown: false });
  }

  // A jusante a sonda pode declarar a queda uma ou duas leituras antes da causa.
  const slackSeconds = config.intervalSeconds * config.failThreshold;
  const closures = new Map<number, Set<number>>();
  const closureOf = (id: number) => closures.get(id) ?? closures.set(id, downstreamClosure(id, uplinks)).get(id)!;
  const isConsequence = (outage: Outage) => outages.some((cause) => cause !== outage &&
    cause.deviceId !== outage.deviceId && closureOf(cause.deviceId).has(outage.deviceId) &&
    // ponytail: dois equipamentos que se alimentam um ao outro escondiam-se mutuamente; o
    // registo de backbone não deixa criar o ciclo.
    !closureOf(outage.deviceId).has(cause.deviceId) &&
    cause.startedAt <= shift(outage.startedAt, slackSeconds) &&
    (cause.status === 'open' || cause.endedAt === null || cause.endedAt > outage.startedAt));

  const clientsOf = db.prepare(CLIENTS_OF_DEVICE_SQL);

  const incidents: NetworkIncident[] = outages
    .filter((outage) => (outage.endedAt ?? now) >= windowStart && !isConsequence(outage))
    .map((outage) => {
      const device = devices.get(outage.deviceId)!;
      const closure = [...closureOf(outage.deviceId)];
      const clients = new Map<number, IncidentClient>();
      for (const id of closure) for (const row of clientsOf.all(id) as IncidentClient[]) clients.set(row.clientId, row);
      const reading = readOutageCause(db, outage.deviceId, outage.startedAt, slackSeconds, uplinks);
      return {
        key: `${outage.deviceId}:${outage.startedAt}`,
        backboneDeviceId: outage.deviceId,
        name: device.name,
        zone: device.zone,
        status: outage.status,
        startedAt: outage.startedAt,
        endedAt: outage.endedAt,
        durationSeconds: outage.status === 'unknown' || outage.observedDown === false ? null : secondsBetween(outage.startedAt, outage.endedAt ?? now),
        draggedDevices: closure.filter((id) => id !== outage.deviceId).map((id) => devices.get(id)!.name).sort(),
        clients: [...clients.values()].sort((a, b) => a.clientCode.localeCompare(b.clientCode)),
        cause: null,
        outageCause: reading.cause,
        causeSource: reading.source,
        siteName: reading.siteName,
        observedDown: outage.observedDown !== false
      };
    });

  // Um corte da antena deixa toda a gente sem internet: afeta todos os clientes com serviço ativo.
  const dishCuts = loadDishIncidents(db, windowStart);
  const everyone = dishCuts.length === 0 ? [] : db.prepare(`
    SELECT DISTINCT c.id AS clientId, c.client_code AS clientCode, c.full_name AS clientName, c.zone
    FROM services s JOIN clients c ON c.id = s.client_id WHERE s.status = 'active' ORDER BY c.client_code
  `).all() as IncidentClient[];
  for (const cut of dishCuts) {
    incidents.push({
      key: `starlink:${cut.dishId}:${cut.startedAt}`,
      backboneDeviceId: null,
      name: cut.name,
      zone: null,
      status: 'resolved',
      startedAt: cut.startedAt,
      endedAt: cut.endedAt,
      durationSeconds: Math.round(cut.durationMs / 1000),
      draggedDevices: [],
      clients: everyone,
      cause: cut.cause,
      outageCause: null,
      causeSource: null,
      siteName: null,
      observedDown: true
    });
  }

  incidents.sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.startedAt.localeCompare(a.startedAt));

  return { probeEnabled: config.enabled, windowDays, incidents };
}

function shift(at: string, seconds: number): string {
  return new Date(Date.parse(`${at.replace(' ', 'T')}Z`) + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { normalizeSmsPhone } from '../../shared/sms';
import { enqueueSmsNotification } from './sms-outbox';
import { enqueueWhatsapp } from './whatsapp-outbox';
import { normalizeWhatsappPhone } from './whatsapp-provider';
import { requestNetworkSync } from './network-sync';
import { recordSystemAuditEntry } from './audit';
import { effectivePeakPercent, effectiveReferenceGb, fupActionText, globalCycleDay, readFupSettings, type FupSettings } from './fup-settings';
import { addSimpleQueue, listActive, listSimpleQueues, patchSimpleQueue, readClockZone, removeSimpleQueue, type RouterTransport } from './routeros';

/**
 * Motor da política de uso justo (FUP).
 *
 * O consumo vem do contador PPPoE que já existe (`client_traffic_daily`, por dia
 * e serviço; tx = download). O motor só decide: grava as transições em
 * `fup_events` e diz que serviços devem estar limitados agora. Quem escreve no
 * router é a reconciliação (`network-enforcement`), que lê `fupLimitedServiceIds`
 * — um router em baixo apanha o que faltou na passagem seguinte.
 *
 * Dentro de um ciclo o estado só sobe (normal → AVISO → LIMITADO) e cada
 * transição grava-se uma vez (chave única serviço+período+tipo). Uma alteração
 * da configuração a meio do ciclo nunca repete um aviso; se subir o limiar de
 * limitação, a limitação deixa de se aplicar já, sem apagar o evento.
 */

export type FupState = 'NORMAL' | 'AVISO' | 'LIMITADO';
export type FupEventKind = 'AVISO' | 'LIMITADO' | 'RESTAURADO';

const GB = 1024 ** 3;

export function bytesToGb(bytes: number): number {
  return bytes / GB;
}

/** Percentagem do consumo de referência; 0 se o plano não tem referência. */
export function usagePercent(bytes: number, referenceGb: number): number {
  if (!(referenceGb > 0)) return 0;
  return (bytes / (referenceGb * GB)) * 100;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `AAAA-MM-DD` no fuso dado. */
export function dayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutos desde a meia-noite no fuso dado. */
export function minutesInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return get('hour') * 60 + get('minute');
}

/** Dentro de [início, fim) no fuso da configuração. */
export function inPeakWindow(now: Date, settings: Pick<FupSettings, 'janela_pico_inicio' | 'janela_pico_fim' | 'fuso_horario'>): boolean {
  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const minutes = minutesInZone(now, settings.fuso_horario);
  const end = settings.janela_pico_fim === '00:00' ? 24 * 60 : toMinutes(settings.janela_pico_fim);
  return minutes >= toMinutes(settings.janela_pico_inicio) && minutes < end;
}

/** Dia em que o ciclo começa: o do serviço, senão o das Definições, senão o da ativação (até 28), senão 1. */
export function cycleStartDay(cycleDay: number | null, activationDate: string | null, globalDay: number | null = null): number {
  if (cycleDay !== null && cycleDay >= 1 && cycleDay <= 28) return cycleDay;
  if (globalDay !== null && globalDay >= 1 && globalDay <= 28) return globalDay;
  const day = activationDate && /^\d{4}-\d{2}-\d{2}/.test(activationDate) ? Number(activationDate.slice(8, 10)) : 1;
  return Math.min(Math.max(day, 1), 28);
}

/** Ciclo que contém `today`: [start, end] inclusivo; o período é o mês do início. */
export function cycleFor(today: string, startDay: number): { start: string; end: string; period: string } {
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  if (Number(today.slice(8, 10)) < startDay) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  const start = `${year}-${pad(month)}-${pad(startDay)}`;
  // Dia anterior ao mesmo dia do mês seguinte; Date.UTC trata a passagem de ano.
  const end = new Date(Date.UTC(year, month, startDay - 1)).toISOString().slice(0, 10);
  return { start, end, period: start.slice(0, 7) };
}

/** Transições a gravar a partir do estado atual. Quem salta direto para lá do limite recebe AVISO e LIMITADO. */
export function nextTransitions(state: FupState, percent: number, settings: Pick<FupSettings, 'limiar_aviso_percent' | 'limiar_limitacao_percent'>): Array<'AVISO' | 'LIMITADO'> {
  const out: Array<'AVISO' | 'LIMITADO'> = [];
  if (state === 'NORMAL' && percent >= settings.limiar_aviso_percent) out.push('AVISO');
  if (state !== 'LIMITADO' && percent >= settings.limiar_limitacao_percent) out.push('LIMITADO');
  return out;
}

export function stateFromEvents(kinds: string[]): FupState {
  if (kinds.includes('LIMITADO')) return 'LIMITADO';
  if (kinds.includes('AVISO')) return 'AVISO';
  return 'NORMAL';
}

export function renderFupMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

// ------------------------------------------------------------------ leitura

export type FupServiceUsage = {
  serviceId: number;
  clientId: number;
  clientName: string;
  phone: string | null;
  whatsappOptOut: boolean;
  status: string;
  username: string;
  planId: number | null;
  planName: string | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  referenceGb: number;
  /** Plafond próprio do serviço; nulo = herda. */
  serviceReferenceGb: number | null;
  /** O que o serviço teria sem plafond próprio (plano ou predefinido). */
  inheritedReferenceGb: number;
  peakPercent: number;
  cycle: { start: string; end: string; period: string };
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  percent: number;
  state: FupState;
  /** A limitação está ativa no ciclo, independentemente da hora. */
  limited: boolean;
  /** Limitado agora: estado LIMITADO, ainda acima do limiar, e dentro da janela de pico. */
  limitedNow: boolean;
};

type Row = {
  serviceId: number; clientId: number; clientName: string; phone: string | null; whatsappOptOut: number; status: string;
  username: string; planId: number | null; planName: string | null; downloadMbps: number | null; uploadMbps: number | null; referenceGb: number | null; serviceReferenceGb: number | null; planPeak: number | null;
  cycleDay: number | null; activationDate: string | null;
};

/**
 * Consumo do ciclo corrente de cada serviço com PPPoE. `settings` pode ser uma
 * configuração candidata (pré-visualização): nada aqui grava.
 */
export function loadFupUsage(db: Database.Database, now: Date, settings: FupSettings, filter: { serviceId?: number } = {}): FupServiceUsage[] {
  const rows = db.prepare(`
    SELECT s.id AS serviceId, c.id AS clientId, c.full_name AS clientName, c.phone AS phone, c.whatsapp_opt_out AS whatsappOptOut,
      s.status AS status, s.pppoe_username AS username, p.id AS planId, p.name AS planName, p.download_mbps AS downloadMbps, p.upload_mbps AS uploadMbps,
      p.fup_reference_gb AS referenceGb, s.fup_reference_gb AS serviceReferenceGb, p.fup_peak_percent AS planPeak, s.fup_cycle_day AS cycleDay, s.activation_date AS activationDate
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.pppoe_username IS NOT NULL AND TRIM(s.pppoe_username) <> ''
      ${filter.serviceId !== undefined ? 'AND s.id = @serviceId' : ''}
    ORDER BY s.id
  `).all(filter.serviceId !== undefined ? { serviceId: filter.serviceId } : {}) as Row[];
  const usage = db.prepare(`SELECT COALESCE(SUM(tx_bytes), 0) AS down, COALESCE(SUM(rx_bytes), 0) AS up
    FROM client_traffic_daily WHERE service_id = ? AND day >= ? AND day <= ?`);
  const events = db.prepare('SELECT kind FROM fup_events WHERE service_id = ? AND period = ?');
  const today = dayInZone(now, settings.fuso_horario);
  // Bloqueado não tem janela: está limitado a toda a hora.
  const peak = settings.acao_ao_limite === 'BLOQUEAR' || inPeakWindow(now, settings);
  const globalDay = globalCycleDay(settings);
  return rows.map((row) => {
    const cycle = cycleFor(today, cycleStartDay(row.cycleDay, row.activationDate, globalDay));
    const { down, up } = usage.get(row.serviceId, cycle.start, cycle.end) as { down: number; up: number };
    const referenceGb = effectiveReferenceGb(row.serviceReferenceGb, row.referenceGb, settings);
    const percent = usagePercent(down + up, referenceGb);
    const state = stateFromEvents((events.all(row.serviceId, cycle.period) as Array<{ kind: string }>).map((e) => e.kind));
    const limited = row.status === 'active' && referenceGb > 0 && state === 'LIMITADO'
      && percent >= settings.limiar_limitacao_percent;
    return {
      serviceId: row.serviceId,
      clientId: row.clientId,
      clientName: row.clientName,
      phone: row.phone,
      whatsappOptOut: row.whatsappOptOut === 1,
      status: row.status,
      username: row.username,
      planId: row.planId,
      planName: row.planName,
      downloadMbps: row.downloadMbps,
      uploadMbps: row.uploadMbps,
      referenceGb,
      serviceReferenceGb: row.serviceReferenceGb,
      inheritedReferenceGb: effectiveReferenceGb(null, row.referenceGb, settings),
      peakPercent: effectivePeakPercent({ fupPeakPercent: row.planPeak }, settings),
      cycle,
      downloadBytes: down,
      uploadBytes: up,
      totalBytes: down + up,
      percent,
      state,
      limited,
      limitedNow: limited && peak
    };
  });
}

/** Serviço → % da velocidade a aplicar durante a janela deste ciclo. */
export function fupLimitedServices(db: Database.Database, now = new Date()): Map<number, number> {
  const settings = readFupSettings(db);
  return new Map(loadFupUsage(db, now, settings).filter((row) => row.limited).map((row) => [row.serviceId, row.peakPercent]));
}

/** Pré-visualização: quantos ficariam em aviso e limitados com a configuração dada e os dados do ciclo. */
export function previewFupImpact(db: Database.Database, now: Date, settings: FupSettings) {
  let aviso = 0;
  let limitados = 0;
  for (const row of loadFupUsage(db, now, settings)) {
    if (row.status !== 'active' || row.referenceGb <= 0) continue;
    if (row.percent >= settings.limiar_limitacao_percent) limitados++;
    else if (row.percent >= settings.limiar_aviso_percent) aviso++;
  }
  return { aviso, limitados };
}

// ------------------------------------------------------------------ motor

export type FupNotice = { serviceId: number; clientId: number; phone: string; body: string; channel: 'SMS' | 'WHATSAPP' };

export type FupEngineDeps = {
  /** Põe o aviso na fila do canal. Lançar não desfaz o evento: o aviso não se repete. */
  enqueueNotice: (notice: FupNotice) => void;
  /** Pede uma passagem da reconciliação quando o conjunto de limitados muda. */
  requestSync: () => void;
};

export type FupEngineSummary = { evaluated: number; events: number; notices: number; limitedNow: number; syncRequested: boolean };

const lastLimited = new WeakMap<Database.Database, string>();

export function runFupEngine(db: Database.Database, now: Date, deps: FupEngineDeps): FupEngineSummary {
  // Lida em cada execução: uma alteração entra na seguinte, sem reiniciar.
  const settings = readFupSettings(db);
  const rows = loadFupUsage(db, now, settings);
  const insert = db.prepare('INSERT OR IGNORE INTO fup_events (service_id, period, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?)');
  const at = now.toISOString().replace('T', ' ').slice(0, 19);
  let events = 0;
  let notices = 0;
  const log = (row: FupServiceUsage, kind: FupEventKind, period: string, detail: Record<string, unknown>) => {
    const inserted = insert.run(row.serviceId, period, kind, JSON.stringify(detail), at).changes === 1;
    if (!inserted) return false;
    events++;
    recordSystemAuditEntry(db, {
      action: `fup.${kind.toLowerCase()}`,
      entityType: 'service',
      entityId: row.serviceId,
      summary: `${row.clientName} (${row.username}): ${kind}`,
      metadata: { period, ...detail }
    });
    return true;
  };

  // LIMITADO → RESTAURADO: um ciclo anterior ficou limitado e ainda não foi fechado.
  const openLimits = db.prepare(`SELECT l.service_id AS serviceId, l.period AS period FROM fup_events l
    WHERE l.kind = 'LIMITADO' AND NOT EXISTS (
      SELECT 1 FROM fup_events r WHERE r.service_id = l.service_id AND r.period = l.period AND r.kind = 'RESTAURADO')`)
    .all() as Array<{ serviceId: number; period: string }>;
  const byId = new Map(rows.map((row) => [row.serviceId, row]));
  for (const open of openLimits) {
    const row = byId.get(open.serviceId);
    if (!row || row.cycle.period === open.period) continue;
    log(row, 'RESTAURADO', open.period, { de: 'LIMITADO', para: 'NORMAL', novoCiclo: row.cycle.start });
  }

  for (const row of rows) {
    if (row.status !== 'active' || row.referenceGb <= 0) continue;
    let state = row.state;
    for (const kind of nextTransitions(state, row.percent, settings)) {
      const detail = {
        de: state, para: kind, percent: Math.round(row.percent), gb: Number(bytesToGb(row.totalBytes).toFixed(1)), // a casa que o ecrã mostra: sem duplo arredondamento
        referenciaGb: row.referenceGb, plano: row.planName, ciclo: `${row.cycle.start}..${row.cycle.end}`
      };
      if (!log(row, kind, row.cycle.period, detail)) continue;
      state = kind;
      // `whatsapp_opt_out` é a única recusa de avisos do ISPM: vale para os dois canais.
      if (kind === 'AVISO' && row.phone && !row.whatsappOptOut) {
        const body = renderFupMessage(settings.mensagem_aviso, {
          nome: row.clientName, percent: Math.round(row.percent), gb: bytesToGb(row.totalBytes).toFixed(1).replace('.', ','),
          referencia: row.referenceGb, inicio: settings.janela_pico_inicio, fim: settings.janela_pico_fim, pico: row.peakPercent,
          acao: fupActionText(settings, row.peakPercent)
        });
        try {
          deps.enqueueNotice({ serviceId: row.serviceId, clientId: row.clientId, phone: row.phone, body, channel: settings.canal_aviso });
          notices++;
        } catch {
          // O evento fica: um aviso que falhou a entrar na fila não se repete sozinho.
        }
      }
    }
  }

  // O estado mudou com as transições: relê para saber quem fica limitado no ciclo.
  const current = loadFupUsage(db, now, settings);
  const limited = current.filter((row) => row.limited).map((row) => `${row.serviceId}:${row.peakPercent}`).join(',');
  const changed = lastLimited.get(db) !== limited;
  lastLimited.set(db, limited);
  if (changed) deps.requestSync();
  return { evaluated: rows.length, events, notices, limitedNow: current.filter((row) => row.limitedNow).length, syncRequested: changed };
}

/** O job `fup_engine`: os avisos entram nas filas que já existem (WhatsApp ou SMS). */
export function runFupEngineIfDue(now = new Date()): FupEngineSummary {
  return runFupEngine(getSqliteDatabase(), now, {
    enqueueNotice: (notice) => {
      if (notice.channel === 'SMS') {
        const toPhone = normalizeSmsPhone(notice.phone);
        if (!toPhone) throw new Error('Telefone inválido para SMS');
        enqueueSmsNotification({ clientId: notice.clientId, serviceId: notice.serviceId, eventType: 'fup_notice', toPhone, body: notice.body });
        return;
      }
      const toPhone = normalizeWhatsappPhone(notice.phone);
      if (!toPhone) throw new Error('Telefone inválido para WhatsApp');
      enqueueWhatsapp({ toPhone, kind: 'text', body: notice.body, clientId: notice.clientId, origin: 'auto' });
    },
    requestSync: requestNetworkSync
  });
}

export function listFupEvents(db: Database.Database, serviceId: number) {
  return db.prepare(`SELECT id, period, kind, detail_json AS detailJson, created_at AS createdAt
    FROM fup_events WHERE service_id = ? ORDER BY id DESC LIMIT 100`).all(serviceId) as Array<{
    id: number; period: string; kind: FupEventKind; detailJson: string | null; createdAt: string;
  }>;
}

// ------------------------------------------------------------------ filas (método QUEUE)

const QUEUE_PREFIX = 'ispm-fup-';
const QUEUE_COMMENT = 'ispm:fup:';

export type FupQueueSummary = { wanted: number; added: number; updated: number; removed: number; failed: number; clockZone: string | null; clockMismatch: boolean | null };

/** `max-limit` de um cliente bloqueado: o mínimo que o RouterOS aceita, que na prática corta a ligação. */
export const FUP_BLOCK_LIMIT = '1k/1k';
/** Fila de um bloqueado: o dia inteiro, todos os dias. */
export const FUP_BLOCK_TIME = '0s-1d,sun,mon,tue,wed,thu,fri,sat';

/** `max-limit` da fila simples (upload/download do cliente) a uma % do plano, em kbit/s. */
export function fupQueueLimit(uploadMbps: number, downloadMbps: number, percent: number): string {
  const k = (mbps: number) => Math.max(1, Math.round(mbps * 10 * percent));
  return `${k(uploadMbps)}k/${k(downloadMbps)}k`;
}

/** RouterOS devolve taxas em bit/s e horas como `18h30m`, mesmo quando aceita `18:30:00`. */
function sameQueueLimit(actual: string | null, desired: string): boolean {
  const parts = (value: string | null) => value?.split('/').map((part) => {
    const match = /^(\d+)([kmg]?)$/i.exec(part.trim());
    if (!match) return NaN;
    return Number(match[1]) * ({ '': 1, k: 1000, m: 1000000, g: 1000000000 }[match[2].toLowerCase()] ?? NaN);
  });
  const left = parts(actual), right = parts(desired);
  return left?.length === 2 && right?.length === 2 && left.every((value, i) => value === right[i]);
}

function sameQueueTime(actual: string | null, desired: string): boolean {
  const normalize = (value: string | null) => {
    const [range, ...days] = (value ?? '').split(',');
    const times = range.split('-').map((time) => {
      if (/^\d{1,2}:\d{2}:\d{2}$/.test(time)) return time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
      return match && match[0] ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0) : NaN;
    });
    return { times, days };
  };
  const left = normalize(actual), right = normalize(desired);
  return left.times.length === 2 && left.times.every((value, i) => value === right.times[i]) && left.days.join(',') === right.days.join(',');
}

/**
 * Uma fila simples `ispm-fup-<serviço>` à frente da fila dinâmica
 * da sessão PPPoE de cada limitado, e nenhuma para os outros. Sem sessão não
 * há interface para apontar: a fila entra na passagem a seguir à ligação.
 * O horário na fila é aplicado pelo router. Cada mudança fica na auditoria
 * com o cliente, o plano e o valor antes e depois.
 */
export async function syncFupQueues(
  db: Database.Database,
  deps: { transport: RouterTransport; dryRun: boolean; now?: Date }
): Promise<FupQueueSummary> {
  const settings = readFupSettings(db);
  // ponytail: bloquear = a mesma fila a 1k o dia todo; a sessão fica, mas não passa tráfego útil. Um só mecanismo, que sai no restauro.
  const block = settings.acao_ao_limite === 'BLOQUEAR';
  // A reduzir, a fila parte das Mbps do plano; a bloquear não precisa delas.
  const rows = loadFupUsage(db, deps.now ?? new Date(), settings).filter((row) => row.limited && (block || (row.downloadMbps && row.uploadMbps)));
  const queues = await listSimpleQueues(deps.transport);
  const ours = new Map(queues.filter((q) => !q.dynamic && q.name.startsWith(QUEUE_PREFIX)).map((q) => [q.name, q]));
  const clockZone = await readClockZone(deps.transport).catch(() => null);
  const summary: FupQueueSummary = { wanted: rows.length, added: 0, updated: 0, removed: 0, failed: 0, clockZone, clockMismatch: clockZone === null ? null : clockZone !== settings.fuso_horario };
  const end = settings.janela_pico_fim === '00:00' ? '24:00' : settings.janela_pico_fim;
  const time = block ? FUP_BLOCK_TIME : `${settings.janela_pico_inicio}:00-${end}:00,sun,mon,tue,wed,thu,fri,sat`;
  if (rows.length === 0 && ours.size === 0) return summary;
  const online = new Set(rows.length ? (await listActive(deps.transport)).map((session) => session.name) : []);
  const audit = (row: Pick<FupServiceUsage, 'serviceId' | 'clientName' | 'username' | 'planName'> | null, serviceId: number, before: string | null, after: string | null) =>
    recordSystemAuditEntry(db, {
      action: 'fup.fila', entityType: 'service', entityId: serviceId,
      summary: `Fila FUP de ${row ? `${row.clientName} (${row.username})` : `serviço ${serviceId}`}: ${before ?? 'sem fila'} → ${after ?? 'sem fila'}`,
      metadata: { plano: row?.planName ?? null, antes: before, depois: after }
    });
  const attempt = async (fn: () => Promise<void>) => {
    if (deps.dryRun) return false;
    try { await fn(); return true; } catch { summary.failed++; return false; }
  };

  const keep = new Set<string>();
  for (const row of rows) {
    const name = `${QUEUE_PREFIX}${row.serviceId}`;
    const target = `<pppoe-${row.username}>`;
    const limit = block ? FUP_BLOCK_LIMIT : fupQueueLimit(row.uploadMbps!, row.downloadMbps!, row.peakPercent);
    const existing = ours.get(name);
    if (existing) {
      keep.add(name);
      if ((!sameQueueLimit(existing.maxLimit, limit) || !sameQueueTime(existing.time, time)) && await attempt(() => patchSimpleQueue(deps.transport, existing.id, { 'max-limit': limit, time }))) {
        summary.updated++;
        audit(row, row.serviceId, existing.maxLimit, limit);
      }
      continue;
    }
    if (!online.has(row.username)) continue;
    const dynamic = queues.find((q) => q.dynamic && q.name === target);
    if (!dynamic?.id) continue;
    if (await attempt(() => addSimpleQueue(deps.transport, { name, target, maxLimit: limit, time, comment: `${QUEUE_COMMENT}${row.serviceId}`, placeBefore: dynamic.id }))) {
      summary.added++;
      keep.add(name);
      audit(row, row.serviceId, null, limit);
    }
  }
  for (const [name, queue] of ours) {
    if (keep.has(name)) continue;
    const serviceId = Number(name.slice(QUEUE_PREFIX.length));
    if (await attempt(() => removeSimpleQueue(deps.transport, queue.id))) {
      summary.removed++;
      audit(null, serviceId, queue.maxLimit, null);
    }
  }
  return summary;
}

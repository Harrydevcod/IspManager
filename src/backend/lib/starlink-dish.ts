import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { detectAdminNetwork, isOffNetwork, offNetworkReason } from './admin-network';

/**
 * A API local da antena Starlink: gRPC-web sem autenticação, só alcançável de dentro da rede
 * (o router encaminha 192.168.100.0/24 para a WAN da antena). Lê-se sem `.proto` nem dependências:
 * os números dos campos são os do `dish.proto` público (medido na Mini a 15/11/2026).
 *
 * ponytail: um endereço fixo serve uma antena; com duas antenas no mesmo IP é preciso uma regra
 * por WAN no router e um endereço por antena aqui.
 */
export const DISH_URL = 'http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle';
// Request { get_status (1004) {} } e Request { get_history (1007) {} }, numa trama gRPC-web.
const GET_STATUS = Uint8Array.from([0, 0, 0, 0, 3, 0xe2, 0x3e, 0]);
const GET_HISTORY = Uint8Array.from([0, 0, 0, 0, 3, 0xfa, 0x3e, 0]);
const TIMEOUT_MS = 4000;

/** Um corte com menos do que isto conta só no resumo; a partir daqui é um incidente. */
export const DISH_INCIDENT_MIN_MS = 5000;
const SAMPLE_DAYS = 30;
const OUTAGE_DAYS = 90;
// O tempo GPS começa a 06/01/1980 e não conta os 18 segundos intercalares desde então.
// ponytail: fixo; muda só se o IERS anunciar outro segundo intercalar.
const GPS_EPOCH_UNIX_MS = (315_964_800 - 18) * 1000;

// ------------------------------------------------------------- protobuf mínimo

type Field = bigint | number | Uint8Array;

function varint(bytes: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = start; i < bytes.length; i++) {
    result |= BigInt(bytes[i] & 0x7f) << shift;
    if (!(bytes[i] & 0x80)) return [result, i + 1];
    shift += 7n;
  }
  throw new Error('varint truncado');
}

/** Os campos de uma mensagem: varint em bigint, fixed32 em float, length-delimited em bytes. */
export function protoFields(bytes: Uint8Array): Map<number, Field[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<number, Field[]>();
  let i = 0;
  while (i < bytes.length) {
    let key: bigint;
    [key, i] = varint(bytes, i);
    const field = Number(key >> 3n);
    let value: Field;
    switch (Number(key & 7n)) {
      case 0: [value, i] = varint(bytes, i); break;
      case 1: value = view.getFloat64(i, true); i += 8; break;
      case 2: {
        let length: bigint;
        [length, i] = varint(bytes, i);
        value = bytes.subarray(i, i + Number(length));
        i += Number(length);
        if (i > bytes.length) throw new Error('campo truncado');
        break;
      }
      case 5: value = view.getFloat32(i, true); i += 4; break;
      default: throw new Error('tipo de campo desconhecido');
    }
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

const first = (fields: Map<number, Field[]>, field: number) => fields.get(field)?.[0];
const num = (fields: Map<number, Field[]>, field: number) => {
  const value = first(fields, field);
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : 0;
};
const text = (fields: Map<number, Field[]>, field: number) => {
  const value = first(fields, field);
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : '';
};
const message = (fields: Map<number, Field[]>, field: number) => {
  const value = first(fields, field);
  return protoFields(value instanceof Uint8Array ? value : new Uint8Array());
};
function packedFloats(fields: Map<number, Field[]>, field: number): number[] {
  const value = first(fields, field);
  if (!(value instanceof Uint8Array)) return [];
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: Math.floor(value.byteLength / 4) }, (_, k) => view.getFloat32(k * 4, true));
}

/** A resposta (campo > 2000) dentro da primeira trama gRPC-web; falha com o grpc-status do trailer. */
export function grpcWebResponse(body: Uint8Array): Map<number, Field[]> {
  if (body.length < 5 || body[0] !== 0) throw new Error('Resposta da antena ilegível');
  const length = new DataView(body.buffer, body.byteOffset).getUint32(1);
  const trailer = new TextDecoder().decode(body.subarray(5 + length + 5));
  const status = /grpc-status:\s*(\d+)/.exec(trailer)?.[1];
  if (status && status !== '0') throw new Error(`A antena recusou o pedido (grpc-status ${status})`);
  const top = protoFields(body.subarray(5, 5 + length));
  const key = [...top.keys()].find((k) => k > 2000);
  if (key === undefined) throw new Error('Resposta da antena sem dados');
  return message(top, key);
}

// ---------------------------------------------------------------------- leitura

export const OUTAGE_CAUSE: Record<number, string> = {
  0: 'Causa desconhecida', 1: 'A arrancar', 2: 'Antena arrumada', 3: 'Desligou por calor', 4: 'Sem horário de satélites',
  5: 'Sem satélites', 6: 'Obstrução', 7: 'Sem sinal do satélite', 8: 'Sem resposta da rede Starlink', 9: 'Motores em movimento',
  10: 'Teste do cabo', 11: 'Em repouso', 13: 'À procura do céu', 14: 'Emissão inibida'
};

// Os alertas que mudam o que se faz; os outros campos de DishAlerts ficam de fora.
const ALERTS: Record<number, string> = {
  1: 'Motores presos', 2: 'Desligou por calor', 3: 'Débito reduzido por calor', 4: 'Local inesperado', 5: 'Mastro inclinado',
  6: 'Cabo de rede lento', 9: 'A aquecer', 10: 'Fonte de alimentação quente', 16: 'Motores com pouca corrente',
  17: 'Sinal abaixo do previsto', 18: 'Cabo de rede a 100 Mbps', 20: 'Água na antena', 21: 'Água no router', 23: 'Sem ligação de rede'
};

export type DishStatus = {
  id: string;
  hardware: string;
  software: string;
  uptimeSeconds: number;
  obstructed: boolean;
  fractionObstructed: number;
  alerts: string[];
  /** A causa do corte em curso; `null` com a antena ligada. */
  outageCause: string | null;
};

export function parseDishStatus(response: Map<number, Field[]>): DishStatus {
  const info = message(response, 1);
  const obstruction = message(response, 1004);
  const alerts = message(response, 1005);
  const outage = response.has(1014) ? message(response, 1014) : null;
  return {
    id: text(info, 1),
    hardware: text(info, 2),
    software: text(info, 3),
    uptimeSeconds: num(message(response, 2), 1),
    obstructed: num(obstruction, 5) === 1,
    fractionObstructed: num(obstruction, 1),
    alerts: Object.entries(ALERTS).filter(([field]) => num(alerts, Number(field)) === 1).map(([, label]) => label),
    outageCause: outage ? OUTAGE_CAUSE[num(outage, 1)] ?? OUTAGE_CAUSE[0] : null
  };
}

export type DishOutage = { startedAt: string; durationMs: number; cause: string };
export type DishMinute = { latencyMs: number | null; dropRate: number; downlinkBps: number; uplinkBps: number };

const utcSql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Os últimos `seconds` de um anel do get_history, do mais antigo ao mais recente. */
export function ringTail(ring: number[], current: number, seconds: number): number[] {
  // A amostra número `i` vive em `i % ring.length`; `current` é quantas já houve.
  const count = Math.min(seconds, current, ring.length);
  return Array.from({ length: count }, (_, k) => ring[(current - count + k) % ring.length]);
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** O último minuto do get_history e os cortes que a antena ainda guarda. */
export function parseDishHistory(response: Map<number, Field[]>): { minute: DishMinute; outages: DishOutage[] } {
  const current = num(response, 1);
  const tail = (field: number) => {
    const ring = packedFloats(response, field);
    return ring.length ? ringTail(ring, current, 60) : [];
  };
  const drop = tail(1001);
  const latency = tail(1002);
  const outages = (response.get(1009) ?? []).flatMap((raw) => {
    if (!(raw instanceof Uint8Array)) return [];
    const outage = protoFields(raw);
    const startNs = first(outage, 2);
    if (typeof startNs !== 'bigint') return [];
    return [{
      startedAt: utcSql(Number(startNs / 1_000_000n) + GPS_EPOCH_UNIX_MS),
      durationMs: Math.round(num(outage, 3) / 1e6),
      cause: OUTAGE_CAUSE[num(outage, 1)] ?? OUTAGE_CAUSE[0]
    }];
  });
  return {
    // Um segundo sem resposta não tem latência: só contam os que responderam.
    minute: { latencyMs: median(latency.filter((_, k) => drop[k] < 1)), dropRate: mean(drop), downlinkBps: mean(tail(1003)), uplinkBps: mean(tail(1004)) },
    outages
  };
}

async function call(request: Uint8Array<ArrayBuffer>, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(DISH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
      body: request,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new Error('A antena Starlink não responde em 192.168.100.1');
  }
  if (!response.ok) throw new Error(`A antena respondeu ${response.status}`);
  return grpcWebResponse(new Uint8Array(await response.arrayBuffer()));
}

export async function readDish(fetchImpl: typeof fetch = fetch) {
  const status = parseDishStatus(await call(GET_STATUS, fetchImpl));
  return { status, ...parseDishHistory(await call(GET_HISTORY, fetchImpl)) };
}

// ------------------------------------------------------------------- gravação

const DISH_KEY = 'starlinkDish';
const ERROR_KEY = 'starlinkDishError';

export function recordDishReading(db: Database.Database, reading: Awaited<ReturnType<typeof readDish>>, now = new Date()) {
  const { status, minute, outages } = reading;
  const at = utcSql(now.getTime());
  const saveOutage = db.prepare(`
    INSERT INTO starlink_dish_outages (dish_id, started_at, duration_ms, cause) VALUES (?, ?, ?, ?)
    ON CONFLICT(dish_id, started_at) DO UPDATE SET duration_ms = MAX(duration_ms, excluded.duration_ms)
  `);
  const setting = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO starlink_dish_samples
        (at, dish_id, latency_ms, drop_rate, downlink_bps, uplink_bps, obstructed, fraction_obstructed, alerts, outage_cause)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(at, status.id, minute.latencyMs, minute.dropRate, minute.downlinkBps, minute.uplinkBps,
      Number(status.obstructed), status.fractionObstructed, status.alerts.join('|'), status.outageCause);
    for (const outage of outages) saveOutage.run(status.id, outage.startedAt, outage.durationMs, outage.cause);
    setting.run(DISH_KEY, JSON.stringify({ hardware: status.hardware, software: status.software, uptimeSeconds: status.uptimeSeconds, readAt: at }));
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(ERROR_KEY);
    db.prepare('DELETE FROM starlink_dish_samples WHERE at < ?').run(utcSql(now.getTime() - SAMPLE_DAYS * 86_400_000));
    db.prepare('DELETE FROM starlink_dish_outages WHERE started_at < ?').run(utcSql(now.getTime() - OUTAGE_DAYS * 86_400_000));
  })();
  return { outages: outages.length };
}

export async function runStarlinkDishIfDue(db = getSqliteDatabase(), fetchImpl: typeof fetch = fetch) {
  const presence = await detectAdminNetwork(db);
  if (isOffNetwork(presence)) return { skipped: true, reason: offNetworkReason(presence) };
  try {
    return recordDishReading(db, await readDish(fetchImpl));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Quem nunca teve antena não fica com um erro a cada minuto à vista: só depois da primeira leitura.
    if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(DISH_KEY)) {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(ERROR_KEY, reason);
    }
    return { skipped: true, reason };
  }
}

// ---------------------------------------------------------------------- vistas

export type StarlinkHealth = {
  name: string;
  software: string;
  readAt: string;
  error: string | null;
  uptimeSeconds: number;
  /** Mediana e pior 5 % da latência, e perda média, na janela. */
  latencyMs: number | null;
  latencyP95Ms: number | null;
  dropRate: number | null;
  obstructed: boolean;
  fractionObstructed: number;
  alerts: string[];
  outageCause: string | null;
  cuts: number;
  cutSeconds: number;
  /** Os cortes de pelo menos `DISH_INCIDENT_MIN_MS`, do mais recente para o mais antigo. */
  longCuts: DishOutage[];
};

/** "mini1_panda_prod2" → "Starlink Mini"; o resto fica "Starlink". */
export const dishName = (hardware: string) => hardware.startsWith('mini') ? 'Starlink Mini' : 'Starlink';

export function loadStarlinkHealth(db: Database.Database, hours: number, now = new Date()): StarlinkHealth | null {
  const raw = (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DISH_KEY) as { value: string } | undefined)?.value;
  if (!raw) return null;
  const info = JSON.parse(raw) as { hardware: string; software: string; uptimeSeconds: number; readAt: string };
  const since = utcSql(now.getTime() - hours * 3_600_000);
  const samples = db.prepare('SELECT latency_ms AS latency, drop_rate AS dropRate FROM starlink_dish_samples WHERE at >= ?')
    .all(since) as Array<{ latency: number | null; dropRate: number }>;
  const latest = db.prepare(`SELECT obstructed, fraction_obstructed AS fraction, alerts, outage_cause AS outageCause
    FROM starlink_dish_samples ORDER BY at DESC LIMIT 1`).get() as { obstructed: number; fraction: number; alerts: string; outageCause: string | null } | undefined;
  const cuts = db.prepare('SELECT started_at AS startedAt, duration_ms AS durationMs, cause FROM starlink_dish_outages WHERE started_at >= ? ORDER BY started_at DESC')
    .all(since) as DishOutage[];
  const latencies = samples.flatMap((row) => row.latency === null ? [] : [row.latency]).sort((a, b) => a - b);
  return {
    name: dishName(info.hardware),
    software: info.software,
    readAt: info.readAt,
    error: (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(ERROR_KEY) as { value: string } | undefined)?.value ?? null,
    uptimeSeconds: info.uptimeSeconds,
    latencyMs: median(latencies),
    latencyP95Ms: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.95)] : null,
    dropRate: samples.length ? mean(samples.map((row) => row.dropRate)) : null,
    obstructed: latest?.obstructed === 1,
    fractionObstructed: latest?.fraction ?? 0,
    alerts: latest?.alerts ? latest.alerts.split('|') : [],
    outageCause: latest?.outageCause ?? null,
    cuts: cuts.length,
    cutSeconds: Math.round(cuts.reduce((sum, cut) => sum + cut.durationMs, 0) / 1000),
    longCuts: cuts.filter((cut) => cut.durationMs >= DISH_INCIDENT_MIN_MS)
  };
}

/** Os cortes longos desde `since` (UTC), para a lista de incidentes. */
export function loadDishIncidents(db: Database.Database, since: string) {
  const raw = (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DISH_KEY) as { value: string } | undefined)?.value;
  if (!raw) return [];
  const name = dishName((JSON.parse(raw) as { hardware: string }).hardware);
  return (db.prepare(`SELECT dish_id AS dishId, started_at AS startedAt, duration_ms AS durationMs, cause FROM starlink_dish_outages
    WHERE started_at >= ? AND duration_ms >= ? ORDER BY started_at DESC`).all(since, DISH_INCIDENT_MIN_MS) as Array<DishOutage & { dishId: string }>)
    .map((cut) => ({ ...cut, name, endedAt: utcSql(Date.parse(`${cut.startedAt.replace(' ', 'T')}Z`) + cut.durationMs) }));
}

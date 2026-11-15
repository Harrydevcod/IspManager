import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { grpcWebResponse, loadStarlinkHealth, parseDishHistory, parseDishStatus, readDish, recordDishReading, ringTail, runStarlinkDishIfDue } from './starlink-dish';
import { loadIncidents } from './network-incidents';

// Codificador protobuf mínimo, só para montar respostas como as da antena.
const varint = (value: bigint | number) => {
  const out: number[] = [];
  let rest = BigInt(value);
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    out.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return out;
};
type Value = bigint | number | string | number[] | { float: number } | { floats: number[] };
const encode = (fields: Array<[number, Value]>): number[] => fields.flatMap(([field, value]) => {
  if (typeof value === 'bigint' || typeof value === 'number') return [...varint((field << 3) | 0), ...varint(value)];
  if (typeof value === 'object' && 'float' in value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value.float, true);
    return [...varint((field << 3) | 5), ...bytes];
  }
  let bytes: number[];
  if (typeof value === 'string') bytes = [...new TextEncoder().encode(value)];
  else if (Array.isArray(value)) bytes = value;
  else {
    const packed = new Uint8Array(value.floats.length * 4);
    value.floats.forEach((float, k) => new DataView(packed.buffer).setFloat32(k * 4, float, true));
    bytes = [...packed];
  }
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
});
const frame = (responseField: number, inner: number[], status = '0') => {
  const message = encode([[3, 44], [responseField, inner]]);
  const trailer = [...new TextEncoder().encode(`grpc-status:${status}\r\ngrpc-message:\r\n`)];
  const header = (flag: number, length: number) => [flag, length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
  return Uint8Array.from([...header(0, message.length), ...message, ...header(0x80, trailer.length), ...trailer]);
};

// 2026-11-15 09:52:05 UTC em nanossegundos GPS (o que a Mini devolveu).
const GPS_NS = (BigInt(Date.parse('2026-11-15T09:52:05Z') / 1000) - 315_964_800n + 18n) * 1_000_000_000n;

const statusBody = (obstruction: Array<[number, Value]> = [[4, { float: 228_980 }], [10, 4544]], alerts: Array<[number, Value]> = [], extra: Array<[number, Value]> = []) => frame(2004, encode([
  [1, encode([[1, 'ut-teste'], [2, 'mini1_panda_prod2'], [3, '2026.10.31.mr90414']])],
  [2, encode([[1, 229_019]])],
  [1004, encode(obstruction)],
  [1005, encode(alerts)],
  ...extra
]));

const historyBody = (outages: Array<[number, bigint, bigint]>) => frame(2006, encode([
  // Anel de 4 segundos com 6 amostras já escritas: as duas mais recentes estão nas posições 0 e 1.
  [1, 6],
  [1001, { floats: [0, 1, 0, 0] }],
  [1002, { floats: [20, 99, 30, 40] }],
  [1003, { floats: [10e6, 0, 30e6, 40e6] }],
  [1004, { floats: [1e6, 0, 3e6, 4e6] }],
  ...outages.map(([cause, start, duration]): [number, Value] => [1009, encode([[1, cause], [2, start], [3, duration]])])
]));

const fakeFetch = (bodies: Uint8Array<ArrayBuffer>[]) => (async () => new Response(bodies.shift()!)) as unknown as typeof fetch;

describe('protocolo da antena', () => {
  test('ringTail devolve o fim do anel por ordem, cheio ou não', () => {
    expect(ringTail([1, 2, 3, 4], 6, 3)).toEqual([4, 1, 2]);
    expect(ringTail([1, 2, 0, 0], 2, 60)).toEqual([1, 2]);
  });

  test('lê o estado: obstrução, alertas e o corte em curso', () => {
    const ok = parseDishStatus(grpcWebResponse(statusBody()));
    expect(ok).toMatchObject({ id: 'ut-teste', hardware: 'mini1_panda_prod2', uptimeSeconds: 229_019, obstructed: false, fractionObstructed: 0, alerts: [], outageCause: null });
    const bad = parseDishStatus(grpcWebResponse(statusBody([[5, 1], [1, { float: 0.25 }]], [[3, 1], [23, 1]], [[1014, encode([[1, 6]])]])));
    expect(bad).toMatchObject({ obstructed: true, fractionObstructed: 0.25 });
    expect(bad.alerts).toEqual(['Débito reduzido por calor', 'Sem ligação de rede']);
    expect(bad.outageCause).toBe('Obstrução');
  });

  test('falha com o grpc-status do trailer', () => {
    expect(() => grpcWebResponse(frame(2004, [], '12'))).toThrow('grpc-status 12');
  });

  test('o último minuto ignora a latência dos segundos sem resposta; os cortes vêm em UTC', () => {
    const { minute, outages } = parseDishHistory(grpcWebResponse(historyBody([[8, GPS_NS, 520_000_000n]])));
    expect(minute.dropRate).toBe(0.25);
    expect(minute.latencyMs).toBe(30);
    expect(minute.downlinkBps).toBe(20e6);
    expect(outages).toEqual([{ startedAt: '2026-11-15 09:52:05', durationMs: 520, cause: 'Sem resposta da rede Starlink' }]);
  });
});

describe('gravação e vistas', () => {
  let db: Database.Database;
  let dataDir: string;
  let close: () => void;
  const NOW = new Date('2026-11-15T20:00:00Z');

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-starlink-dish-test-'));
    process.env.ISPM_DATA_DIR = dataDir;
    const database = await import('../db/database');
    database.getDatabase();
    db = database.getSqliteDatabase();
    close = database.closeDatabaseForTests;
  });
  beforeEach(() => {
    for (const table of ['starlink_dish_samples', 'starlink_dish_outages', 'services', 'clients']) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'starlinkDish%'").run();
  });
  afterAll(() => {
    close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.ISPM_DATA_DIR;
  });

  const longCut = (GPS_NS + 3_600n * 1_000_000_000n);
  const read = () => readDish(fakeFetch([statusBody(), historyBody([[8, GPS_NS, 520_000_000n], [7, longCut, 12_400_000_000n]])]));

  test('sem leitura não há cartão; o erro só se guarda depois da primeira', async () => {
    expect(loadStarlinkHealth(db, 72, NOW)).toBeNull();
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await runStarlinkDishIfDue(db, failing)).toMatchObject({ skipped: true, reason: 'A antena Starlink não responde em 192.168.100.1' });
    expect(db.prepare("SELECT 1 FROM app_settings WHERE key = 'starlinkDishError'").get()).toBeUndefined();

    recordDishReading(db, await read(), NOW);
    await runStarlinkDishIfDue(db, failing);
    expect(loadStarlinkHealth(db, 72, NOW)?.error).toBe('A antena Starlink não responde em 192.168.100.1');
  });

  test('o mesmo corte lido duas vezes conta uma; só o longo passa a incidente, com todos os clientes', async () => {
    recordDishReading(db, await read(), new Date(NOW.getTime() - 60_000));
    recordDishReading(db, await read(), NOW);
    const health = loadStarlinkHealth(db, 72, NOW)!;
    expect(health).toMatchObject({ name: 'Starlink Mini', cuts: 2, cutSeconds: 13, latencyMs: 30, dropRate: 0.25, error: null });
    expect(health.longCuts).toEqual([{ startedAt: '2026-11-15 10:52:05', durationMs: 12_400, cause: 'Sem sinal do satélite' }]);

    const clientId = Number(db.prepare("INSERT INTO clients (client_code, full_name) VALUES ('C1', 'Cliente C1')").run().lastInsertRowid);
    db.prepare("INSERT INTO services (client_id, status) VALUES (?, 'active')").run(clientId);
    const { incidents } = loadIncidents(db, 30, '2026-11-15 20:00:00');
    expect(incidents).toEqual([expect.objectContaining({
      name: 'Starlink Mini', backboneDeviceId: null, status: 'resolved', startedAt: '2026-11-15 10:52:05', endedAt: '2026-11-15 10:52:17',
      durationSeconds: 12, cause: 'Sem sinal do satélite', clients: [expect.objectContaining({ clientCode: 'C1' })]
    })]);
  });
});

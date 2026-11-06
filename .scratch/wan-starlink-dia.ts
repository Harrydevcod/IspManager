// Repõe um dia da WAN1 com o total da conta Starlink (↓+↑, dia UTC) quando o contador do router o
// perdeu num arranque (ver routeros-usage-store.ts). Generaliza wan-starlink-2026-11-02.ts.
// Correr com o ISPM FECHADO:  npx tsx .scratch/wan-starlink-dia.ts 2026-11-05 201.4
import { getDatabase, getSqliteDatabase } from '../src/backend/db/database';
import { importStarlinkUsage } from '../src/backend/lib/wan-usage';

const [day, raw] = process.argv.slice(2);
const gb = Number(raw);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('Uso: wan-starlink-dia.ts AAAA-MM-DD GB');
if (!Number.isFinite(gb) || gb < 60 || gb > 500) throw new Error(`Valor fora do plausível: ${raw}`);
getDatabase();
const db = getSqliteDatabase();
const read = () => db.prepare('SELECT day, interface, rx_bytes, tx_bytes, source FROM wan_traffic_daily WHERE day = ?').all(day);
console.log('antes:', read());
console.log(importStarlinkUsage(db, [{ day, interface: 'WAN1-STARLINK', bytes: Math.round(gb * 1e9) }]));
console.log('depois:', read());

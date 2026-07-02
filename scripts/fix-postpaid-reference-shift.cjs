#!/usr/bin/env node
/**
 * Correção one-off (2026-07): desloca TODOS os reference_month mensais de
 * payments em −1 mês. Historicamente as faturas foram rotuladas com o mês de
 * geração, não com o mês de consumo (pós-pago) — todos os rótulos estavam
 * +1 mês à frente. NÃO é migration: correção de dados desta instalação.
 *
 * Uso:
 *   node scripts/fix-postpaid-reference-shift.cjs           # dry-run (só imprime)
 *   node scripts/fix-postpaid-reference-shift.cjs --apply   # executa (com backup)
 *
 * A app deve estar FECHADA ao correr com --apply.
 */
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const FLAG_KEY = 'refShiftApplied';

// Mesma resolução de src/backend/lib/paths.ts
const dataDir = process.env.ISPM_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), 'ISPM');
const dbPath = path.join(dataDir, 'ispm.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`BD nao encontrada: ${dbPath}`);
  process.exit(1);
}

/** '2026-07' → '2026-06'; '2026-01' → '2025-12'. */
function shiftMonth(ref) {
  const [y, m] = ref.split('-').map(Number);
  const y2 = m === 1 ? y - 1 : y;
  const m2 = m === 1 ? 12 : m - 1;
  return `${y2}-${String(m2).padStart(2, '0')}`;
}

function histogram(db) {
  return db.prepare(`
    SELECT reference_month ref, count(*) n
    FROM payments GROUP BY reference_month ORDER BY reference_month
  `).all();
}

const db = new Database(dbPath, { readonly: !APPLY });

const alreadyApplied = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(FLAG_KEY);
if (alreadyApplied) {
  console.error(`Correcao ja aplicada em ${alreadyApplied.value}. Abortar (correr 2x deslocaria -2 meses).`);
  process.exit(1);
}

// Só rótulos mensais AAAA-MM (exclui AV-AAAA-MM e outros formatos).
const rows = db.prepare(`
  SELECT id, service_id AS serviceId, reference_month AS ref, status
  FROM payments
  WHERE reference_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
  ORDER BY reference_month ASC, id ASC
`).all();

if (rows.length === 0) {
  console.log('Nada a deslocar.');
  process.exit(0);
}

// Pré-validação: os novos (service_id, ref) ativos não podem duplicar.
const seen = new Set();
const collisions = [];
for (const row of rows) {
  if (row.status === 'cancelled') continue;
  const key = `${row.serviceId}|${shiftMonth(row.ref)}`;
  if (seen.has(key)) collisions.push({ id: row.id, serviceId: row.serviceId, newRef: shiftMonth(row.ref) });
  seen.add(key);
}
if (collisions.length) {
  console.error('Colisoes previstas — dados patologicos, abortar:');
  console.error(JSON.stringify(collisions, null, 2));
  process.exit(1);
}

console.log(`BD: ${dbPath}`);
console.log(`Linhas a deslocar -1 mes: ${rows.length}`);
console.log('Antes:', histogram(db).map((h) => `${h.ref}:${h.n}`).join('  '));

const maxNewRef = shiftMonth(rows[rows.length - 1].ref);
const newLastAutoBilling = shiftMonth(maxNewRef); // catch-up gera o mês em falta no arranque
console.log(`lastAutoBillingMonth: -> ${newLastAutoBilling} (catch-up preenche ${maxNewRef} em falta)`);

if (!APPLY) {
  const preview = new Map();
  for (const row of rows) {
    const target = shiftMonth(row.ref);
    preview.set(target, (preview.get(target) || 0) + 1);
  }
  console.log('Depois (previsto):', [...preview.entries()].map(([r, n]) => `${r}:${n}`).join('  '));
  console.log('\nDry-run: nada foi alterado. Correr com --apply para executar.');
  process.exit(0);
}

// Backup antes de tocar (checkpoint para o .sqlite conter tudo).
db.pragma('wal_checkpoint(TRUNCATE)');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(dataDir, `ispm.pre-refshift-${stamp}.sqlite`);
fs.copyFileSync(dbPath, backupPath);
console.log(`Backup: ${backupPath}`);

const update = db.prepare('UPDATE payments SET reference_month = ?, updated_at = datetime(\'now\') WHERE id = ?');
db.transaction(() => {
  for (const row of rows) update.run(shiftMonth(row.ref), row.id); // ASC: destino já libertado
  db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(newLastAutoBilling, 'lastAutoBillingMonth');
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(FLAG_KEY, new Date().toISOString());
})();

console.log('Depois:', histogram(db).map((h) => `${h.ref}:${h.n}`).join('  '));
console.log('Concluido.');
db.close();

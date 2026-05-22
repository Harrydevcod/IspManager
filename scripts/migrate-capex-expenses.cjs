#!/usr/bin/env node
/**
 * Migrate misclassified CAPEX expenses (category='equipamento')
 * into proper investments + investment_items.
 *
 * Usage:
 *   node scripts/migrate-capex-expenses.cjs            # dry-run (default)
 *   node scripts/migrate-capex-expenses.cjs --apply    # actually mutate
 *   node scripts/migrate-capex-expenses.cjs --db <path>
 *
 * Default DB path: %APPDATA%/ispm/ispm.sqlite
 * Before --apply: copies the DB to <dbpath>.bak.<timestamp> next to it.
 * Wraps INSERT + DELETE in a single transaction.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const DB_PATH = dbArgIdx > -1
  ? process.argv[dbArgIdx + 1]
  : path.join(process.env.APPDATA || '', 'ispm', 'ispm.sqlite');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) fail(`DB not found at ${DB_PATH}`);

const PLAN = [
  {
    investment: {
      name: 'Backbone Starlink',
      type: 'infraestrutura',
      description: 'Uplink central da rede ISP (migrado de expenses categoria=equipamento).',
      investment_date: '2025-04-20',
      reference_month: '2025-04',
      status: 'ativo',
      installed_clients: 22,
      target_clients: 22,
      desired_payback_months: 24,
      desired_margin_pct: 30,
      expected_monthly_revenue_cve: 0,
      monthly_operational_cost_cve: 0,
      notes: 'Migrado automaticamente do registo expenses #3.'
    },
    expenseIds: [3]
  },
  {
    investment: {
      name: 'Inventário CPE + Routers (cliente)',
      type: 'equipamento',
      description: 'Stock acumulado de antenas CPE e routers entregues a clientes (migrado de expenses categoria=equipamento).',
      investment_date: '2025-10-01',
      reference_month: '2025-10',
      status: 'ativo',
      installed_clients: 22,
      target_clients: 22,
      desired_payback_months: 18,
      desired_margin_pct: 30,
      expected_monthly_revenue_cve: 0,
      monthly_operational_cost_cve: 0,
      notes: 'Migrado automaticamente dos registos expenses #4 #5 #6 #7 #8 #9.'
    },
    expenseIds: [4, 5, 6, 7, 8, 9]
  }
];

function itemTypeFor(description) {
  const d = (description || '').toLowerCase();
  if (d.includes('antena') && d.includes('starlink')) return 'antena';
  if (d.includes('antena')) return 'cpe';
  if (d.includes('router')) return 'router';
  return 'outro';
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const expenseRows = db.prepare(`
  SELECT id, expense_date, reference_month, description, supplier, amount_cve,
         category, investment_id AS investmentId, zone, client_id AS clientId
  FROM expenses
  WHERE category = 'equipamento'
  ORDER BY id
`).all().reduce((acc, r) => { acc[r.id] = r; return acc; }, {});

const allWanted = PLAN.flatMap((p) => p.expenseIds);
const missing = allWanted.filter((id) => !expenseRows[id]);
if (missing.length) {
  fail(`Expenses não encontrados ou já migrados: ${missing.join(', ')}. Cancelando.`);
}

const fullPlan = PLAN.map((entry) => {
  const items = entry.expenseIds.map((id) => {
    const e = expenseRows[id];
    return {
      sourceExpenseId: id,
      item_type: itemTypeFor(e.description),
      item_name: e.supplier ? `${e.description} — ${e.supplier}` : e.description,
      quantity: 1,
      unit_cost_cve: e.amount_cve,
      total_cost_cve: e.amount_cve,
      quantity_used: 0
    };
  });
  const total = items.reduce((s, it) => s + it.total_cost_cve, 0);
  return { ...entry, items, total };
});

console.log('═════════════════════════════════════════════════════════');
console.log(' MIGRAÇÃO CAPEX  expenses → investments + investment_items');
console.log('═════════════════════════════════════════════════════════');
console.log(`DB: ${DB_PATH}`);
console.log(`Modo: ${APPLY ? 'APPLY (vai mutar)' : 'DRY-RUN (sem alterações)'}\n`);

let grandTotal = 0;
fullPlan.forEach((plan, idx) => {
  console.log(`Investment ${idx + 1}: ${plan.investment.name}`);
  console.log(`  type=${plan.investment.type}  date=${plan.investment.investment_date}  status=${plan.investment.status}`);
  console.log(`  installed_clients=${plan.investment.installed_clients}  payback=${plan.investment.desired_payback_months}m`);
  console.log(`  items:`);
  plan.items.forEach((it) => {
    console.log(`    #expense=${it.sourceExpenseId}  type=${it.item_type.padEnd(8)}  ${String(it.total_cost_cve).padStart(7)} CVE  "${it.item_name}"`);
  });
  console.log(`  TOTAL: ${plan.total} CVE\n`);
  grandTotal += plan.total;
});

console.log(`Total a migrar: ${grandTotal} CVE em ${fullPlan.length} investments e ${fullPlan.reduce((s, p) => s + p.items.length, 0)} items.`);
console.log(`Expenses a remover: ${allWanted.join(', ')}.\n`);

if (!APPLY) {
  console.log('Dry-run completo. Para aplicar, corre novamente com --apply.');
  db.close();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${DB_PATH}.bak.${stamp}`;
console.log(`Backup → ${backupPath}`);
db.pragma('wal_checkpoint(FULL)');
fs.copyFileSync(DB_PATH, backupPath);

const insertInvestment = db.prepare(`
  INSERT INTO investments (
    name, type, client_id, zone, description, investment_date, reference_month,
    status, expected_monthly_revenue_cve, total_cost_cve, notes,
    target_clients, installed_clients, desired_payback_months, desired_margin_pct,
    monthly_operational_cost_cve, accumulated_revenue_cve
  ) VALUES (
    @name, @type, NULL, NULL, @description, @investment_date, @reference_month,
    @status, @expected_monthly_revenue_cve, @total_cost_cve, @notes,
    @target_clients, @installed_clients, @desired_payback_months, @desired_margin_pct,
    @monthly_operational_cost_cve, 0
  )
`);

const insertItem = db.prepare(`
  INSERT INTO investment_items (
    investment_id, item_type, item_name, quantity, unit_cost_cve, total_cost_cve, quantity_used
  ) VALUES (
    @investment_id, @item_type, @item_name, @quantity, @unit_cost_cve, @total_cost_cve, @quantity_used
  )
`);

const deleteExpense = db.prepare('DELETE FROM expenses WHERE id = ?');

const runMigration = db.transaction(() => {
  const created = [];
  for (const plan of fullPlan) {
    const row = insertInvestment.run({ ...plan.investment, total_cost_cve: plan.total });
    const investmentId = Number(row.lastInsertRowid);
    for (const item of plan.items) {
      insertItem.run({ investment_id: investmentId, ...item });
    }
    for (const expenseId of plan.expenseIds) {
      deleteExpense.run(expenseId);
    }
    created.push({ id: investmentId, name: plan.investment.name, items: plan.items.length });
  }
  return created;
});

const created = runMigration();
console.log('\n✔ Migração aplicada.');
created.forEach((c) => console.log(`  • Investment #${c.id}  "${c.name}"  (${c.items} items)`));
console.log(`  • Expenses removidas: ${allWanted.length}`);
console.log(`\nBackup preservado em: ${backupPath}`);

db.close();

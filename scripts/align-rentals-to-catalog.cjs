/**
 * Acerta o aluguer dos equipamentos instalados ao preço do catálogo.
 *
 * A renda nasce copiada do catálogo no momento da instalação e fica congelada
 * na atribuição — é isso que faz uma fatura antiga continuar a valer o que
 * valia. O efeito colateral é a deriva: mudar o preço no catálogo não acerta o
 * parque já instalado, e não há caminho na aplicação para o corrigir.
 *
 * Este script fecha essa distância, com cuidados:
 *   - só atribuições **abertas** (`end_date IS NULL`) e de propriedade `isp`;
 *     equipamento já retirado ou do cliente não se toca
 *   - faturas passadas não se reescrevem: isto muda o que se cobra daqui para a
 *     frente, nunca o que já foi emitido
 *   - cada acerto deixa uma linha na auditoria
 *
 * Uso:
 *   node scripts/align-rentals-to-catalog.cjs            # simulação (não escreve)
 *   node scripts/align-rentals-to-catalog.cjs --apply    # escreve
 */
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const dataDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ispm'
);

const db = new Database(path.join(dataDir, 'ispm.sqlite'));
db.pragma('foreign_keys = ON');

const divergent = db.prepare(`
  SELECT a.id, c.full_name AS client, e.model, a.rental_fee_cve AS atual,
         COALESCE(e.rental_fee_cve, 0) AS catalogo
    FROM service_device_assignments a
    JOIN equipment_catalog e ON e.id = a.catalog_id
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
   WHERE a.end_date IS NULL
     AND a.ownership = 'isp'
     AND COALESCE(a.rental_fee_cve, 0) <> COALESCE(e.rental_fee_cve, 0)
   ORDER BY c.full_name
`).all();

for (const row of divergent) {
  const sinal = row.catalogo > row.atual ? '+' : '';
  console.log(`${row.client.padEnd(20)} ${row.model.slice(0, 40).padEnd(42)} ${row.atual} → ${row.catalogo} (${sinal}${row.catalogo - row.atual})`);
}

const delta = divergent.reduce((total, row) => total + (row.catalogo - row.atual), 0);
if (!apply) {
  console.log(`\nSimulação: ${divergent.length} acerto(s), ${delta >= 0 ? '+' : ''}${delta} CVE por mês. Corre com --apply para escrever.`);
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE service_device_assignments SET rental_fee_cve = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = ? AND end_date IS NULL
`);
const audit = db.prepare(`
  INSERT INTO audit_logs (actor_username, actor_role, action, entity_type, entity_id, summary, metadata_json)
  VALUES ('align-rentals-to-catalog', 'system', 'assignment_rental_align', 'service_device_assignment', ?, ?, ?)
`);

let written = 0;
db.transaction(() => {
  for (const row of divergent) {
    if (update.run(row.catalogo, row.id).changes === 0) continue;
    written += 1;
    audit.run(
      row.id,
      `${row.model}: ${row.atual} → ${row.catalogo}`,
      JSON.stringify({ de: row.atual, para: row.catalogo, modelo: row.model, cliente: row.client })
    );
  }
})();

console.log(`\n${written} aluguer(es) acertados, ${delta >= 0 ? '+' : ''}${delta} CVE por mês a partir da próxima faturação.`);
db.close();

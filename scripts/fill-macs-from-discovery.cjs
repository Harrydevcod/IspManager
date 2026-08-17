/**
 * Preenche o MAC em falta dos equipamentos registados, a partir do que a
 * Descoberta já viu na rede.
 *
 * A varredura fica com o MAC de cada endereço em `network_discovery_hosts`; o
 * backbone e as atribuições de equipamento têm a coluna `mac_address` vazia
 * porque ninguém a escreve à mão. Isto casa os dois **pelo endereço IP** — a
 * mesma chave que a Descoberta usa — e escreve o que falta.
 *
 * Conservador de propósito:
 *   - só escreve onde o MAC está vazio; nunca sobrepõe um que já lá esteja
 *   - só toca em registos vivos (backbone não abatido, atribuição sem data de
 *     retirada), que são os que ocupam um endereço
 *   - se o mesmo MAC casasse com mais do que um registo, salta os dois e diz
 *     quais — dois equipamentos com o mesmo MAC é erro de dados, não é escolha
 *     que um script deva fazer
 *   - cada escrita deixa uma linha na auditoria
 *
 * Uso:
 *   node scripts/fill-macs-from-discovery.cjs            # simulação (não escreve)
 *   node scripts/fill-macs-from-discovery.cjs --apply    # escreve
 */
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const dataDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ispm'
);
const dbPath = path.join(dataDir, 'ispm.sqlite');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const candidates = db.prepare(`
  SELECT 'backbone' AS kind, b.id AS id, b.name AS name, TRIM(b.ip_address) AS ip,
         h.mac_address AS mac, h.vendor AS vendor
    FROM backbone_devices b
    JOIN network_discovery_hosts h ON h.ip_address = TRIM(b.ip_address)
   WHERE b.status <> 'retired'
     AND NULLIF(TRIM(COALESCE(b.mac_address, '')), '') IS NULL
     AND h.mac_address IS NOT NULL
  UNION ALL
  SELECT 'assignment', a.id, c.full_name, TRIM(a.ip_address), h.mac_address, h.vendor
    FROM service_device_assignments a
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    JOIN network_discovery_hosts h ON h.ip_address = TRIM(a.ip_address)
   WHERE a.end_date IS NULL
     AND NULLIF(TRIM(COALESCE(a.mac_address, '')), '') IS NULL
     AND h.mac_address IS NOT NULL
   ORDER BY 1, 4
`).all();

// Um MAC pertence a um equipamento só. Se casar com dois registos, algum dos
// dois tem o IP errado — e adivinhar qual não é trabalho de um script.
const byMac = new Map();
for (const row of candidates) {
  if (!byMac.has(row.mac)) byMac.set(row.mac, []);
  byMac.get(row.mac).push(row);
}
const ambiguous = [...byMac.values()].filter((rows) => rows.length > 1);
const ambiguousIds = new Set(ambiguous.flat().map((row) => `${row.kind}#${row.id}`));
const writable = candidates.filter((row) => !ambiguousIds.has(`${row.kind}#${row.id}`));

for (const row of writable) {
  console.log(`${row.kind.padEnd(10)} ${row.ip.padEnd(15)} ${row.mac}  ${(row.vendor || '—').padEnd(16)} ${row.name}`);
}
for (const group of ambiguous) {
  console.warn(`SALTADO — ${group[0].mac} casa com ${group.length} registos: ${group.map((r) => `${r.kind}#${r.id} (${r.ip})`).join(', ')}`);
}

if (!apply) {
  console.log(`\nSimulação: ${writable.length} MAC(s) por preencher, ${ambiguous.length} conflito(s). Corre com --apply para escrever.`);
  db.close();
  process.exit(0);
}

const updateBackbone = db.prepare(`
  UPDATE backbone_devices SET mac_address = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = ? AND NULLIF(TRIM(COALESCE(mac_address, '')), '') IS NULL
`);
const updateAssignment = db.prepare(`
  UPDATE service_device_assignments SET mac_address = ?, updated_at = CURRENT_TIMESTAMP
   WHERE id = ? AND NULLIF(TRIM(COALESCE(mac_address, '')), '') IS NULL
`);
const audit = db.prepare(`
  INSERT INTO audit_logs (actor_username, actor_role, action, entity_type, entity_id, summary, metadata_json)
  VALUES ('fill-macs-from-discovery', 'system', 'device_mac_backfill', ?, ?, ?, ?)
`);

let written = 0;
db.transaction(() => {
  for (const row of writable) {
    const statement = row.kind === 'backbone' ? updateBackbone : updateAssignment;
    const result = statement.run(row.mac, row.id);
    if (result.changes === 0) continue;
    written += 1;
    audit.run(
      row.kind === 'backbone' ? 'backbone_device' : 'service_device_assignment',
      row.id,
      `${row.ip} → ${row.mac}`,
      JSON.stringify({ ip: row.ip, mac: row.mac, vendor: row.vendor, source: 'network_discovery_hosts' })
    );
  }
})();

console.log(`\n${written} MAC(s) escritos, ${ambiguous.length} conflito(s) saltados.`);
db.close();

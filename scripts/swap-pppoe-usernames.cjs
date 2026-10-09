/**
 * Troca o utilizador PPPoE entre dois serviços.
 *
 * Existe para acertar um nome que não segue o código do cliente (a C0014 com o
 * `skn001` que pertencia à C0001). Não há caminho na aplicação: o nome é único
 * e trocar dois exige passar por um terceiro.
 *
 * Só os nomes trocam. Cada serviço fica com a sua senha, e no router cada
 * secret fica com o seu serviço — por isso os secrets têm de ser renomeados no
 * router **antes** (Winbox), com o ISPM fechado, senão a passagem seguinte
 * reporta os dois como renomeados.
 *
 * Antes de escrever guarda uma cópia da base ao lado dela.
 *
 * Uso:
 *   node scripts/swap-pppoe-usernames.cjs 3 15            # simulação (não escreve)
 *   node scripts/swap-pppoe-usernames.cjs 3 15 --apply    # escreve
 */
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const ids = process.argv.slice(2).filter((arg) => /^\d+$/.test(arg)).map(Number);
if (ids.length !== 2 || ids[0] === ids[1]) {
  console.error('Uso: node scripts/swap-pppoe-usernames.cjs <serviço A> <serviço B> [--apply]');
  process.exit(1);
}

const dataDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ispm'
);
const db = new DatabaseSync(path.join(dataDir, 'ispm.sqlite'), { readOnly: !apply });

const read = db.prepare(`
  SELECT s.id, s.pppoe_username AS username, c.client_code AS code, c.full_name AS client
  FROM services s JOIN clients c ON c.id = s.client_id
  WHERE s.id = ?
`);
const [a, b] = ids.map((id) => read.get(id));
if (!a || !b || !a.username?.trim() || !b.username?.trim()) {
  console.error('Os dois serviços têm de existir e ter utilizador PPPoE.');
  process.exit(1);
}

console.log(`${a.code} ${a.client} (serviço ${a.id}): ${a.username} → ${b.username}`);
console.log(`${b.code} ${b.client} (serviço ${b.id}): ${b.username} → ${a.username}`);

if (!apply) {
  console.log('\nSimulação: nada foi escrito. Repita com --apply (com o ISPM fechado).');
  process.exit(0);
}

const backup = path.join(dataDir, `ispm.before-swap-pppoe.${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\nCópia: ${backup}`);

const rename = db.prepare(`UPDATE services SET pppoe_username = ?, updated_at = datetime('now') WHERE id = ?`);
db.exec('BEGIN IMMEDIATE');
try {
  // O índice único não deixa os dois nomes coexistirem: um passa por nulo.
  rename.run(null, a.id);
  rename.run(a.username, b.id);
  rename.run(b.username, a.id);
  db.prepare(`
    INSERT INTO audit_logs (actor_username, actor_role, action, entity_type, entity_id, summary)
    VALUES ('script', 'system', 'pppoe_username_swap', 'service', ?, ?)
  `).run(String(a.id), `Trocou os utilizadores PPPoE dos serviços ${a.id} (${b.username}) e ${b.id} (${a.username})`);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('Trocado. Abra o ISPM e sincronize com o router.');

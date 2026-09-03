/**
 * Acerta as zonas dos clientes a uma lista fechada.
 *
 * O painel "Zonas mais rentaveis" passou a agrupar pela zona do CLIENTE. Ao
 * olhar para a base real vi que o campo Zona e o campo Morada tinham sido
 * usados um pelo outro: o mesmo par de valores aparece trocado entre clientes
 *
 *   #7  Aristides      zona=Espia            morada=Cavoque Brumedje
 *   #10 Junior Taxista zona=Cavoque Brumedje morada=Espia
 *
 * e havia treze "zonas" para trinta clientes, quase todas com um so cliente,
 * porque metade delas nao eram zonas — eram pontos de referencia dentro de uma
 * ("Atras Escola Espia", "Praca fonte ines", "Rua abaixo Voo").
 *
 * Este script poe a zona certa no campo Zona e o ponto de referencia na Morada.
 * Nao inventa: cada linha da tabela abaixo foi decidida a olhar para os dois
 * campos, e as cinco em que os dois apontavam para zonas diferentes ficaram de
 * fora — estao listadas no fim para reveres a morada a mao.
 *
 * Decisoes do dono (2026-09-03):
 *   - Cavoque e Tcham Brumedje sao referencias DENTRO da Espia, nao uma zona.
 *   - Onde os dois campos discordam, manda o campo Zona.
 *
 * Simulacao por omissao. `--apply` escreve, e ou o lote todo confere ou nao se
 * escreve nada.
 *
 *   node scripts/normalize-zones.cjs
 *   node scripts/normalize-zones.cjs --apply
 */
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const dataDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ispm'
);

/** As zonas que sobram. Tudo o resto era referencia ou grafia. */
const ZONAS = ['Espia', 'Cruz', 'Fonte Inês', 'Zona Verde', 'Ribeira de Cadela'];

/**
 * clientCode -> { zona, referencia }
 *
 * `referencia` e o ponto de referencia que vinha escrito no campo Zona e que
 * passa para a Morada — sem isto, acertar a zona apagava a unica indicacao de
 * onde a pessoa mora. Ausente = a morada nao se toca.
 */
const ACERTOS = {
  'Atras Escola Espia': { zona: 'Espia', referencia: 'Atrás Escola Espia' },
  'Frente Escola Espia': { zona: 'Espia', referencia: 'Frente Escola Espia' },
  'Cavoque Brumedje': { zona: 'Espia', referencia: 'Cavoque Brumedje' },
  'Tcham Brumedje': { zona: 'Espia', referencia: 'Tcham Brumedje' },
  'Pegode Junior': { zona: 'Espia', referencia: 'Pegode Junior' },
  'Atras Campo': { zona: 'Cruz', referencia: 'Atrás Campo' },
  'Praça fonte ines': { zona: 'Fonte Inês', referencia: 'Praça Fonte Inês' },
  'Rua abaixo Voo': { zona: 'Fonte Inês', referencia: 'Rua abaixo Voo' },
  'Rbera de Cadela': { zona: 'Ribeira de Cadela' }
};

/** Zona em branco: vem da morada, que nesses tres casos so tem o nome da zona. */
const DA_MORADA = { Espia: 'Espia', 'Zona Verde': 'Zona Verde' };

/** Acentos e caixa fora: "Fonte Ines" e "Fonte Inês" sao a mesma coisa escrita. */
const chave = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

const db = new Database(path.join(dataDir, 'ispm.sqlite'));
db.pragma('foreign_keys = ON');

const clientes = db.prepare(`
  SELECT id, client_code AS codigo, full_name AS nome, zone AS zona, address AS morada
    FROM clients ORDER BY full_name
`).all();

const escritas = [];
const conflitos = [];
const intactos = [];

for (const c of clientes) {
  const zonaAtual = (c.zona || '').trim();
  const morada = (c.morada || '').trim();

  let zona = null;
  let referencia = null;

  if (!zonaAtual) {
    zona = DA_MORADA[morada] || null;
    if (!zona) { intactos.push(`${c.nome}: sem zona e sem morada que a diga`); continue; }
  } else if (ACERTOS[zonaAtual]) {
    ({ zona, referencia = null } = ACERTOS[zonaAtual]);
  } else if (ZONAS.includes(zonaAtual)) {
    zona = zonaAtual;
  } else {
    intactos.push(`${c.nome}: zona "${zonaAtual}" fora da lista — NAO TOCADA`);
    continue;
  }

  // Morada que nomeia OUTRA zona da lista: o campo Zona ganha (decisao do dono),
  // mas fica registado — foi alguem a escrever duas moradas diferentes.
  const outraZona = ZONAS.find((z) => chave(z) !== chave(zona) && chave(morada).startsWith(chave(z)));
  if (outraZona) conflitos.push(`${c.nome}: zona=${zona}, morada diz "${morada}"`);

  // A referencia substitui a morada quando esta so repetia o nome da zona; se
  // dizia outra coisa, junta-se, que e informacao que ninguem escreveu duas vezes.
  let novaMorada = c.morada;
  if (referencia) {
    novaMorada = (!morada || chave(morada) === chave(zona)) ? referencia : `${referencia} — ${morada}`;
  }

  if (zona === zonaAtual && novaMorada === c.morada) { intactos.push(`${c.nome}: ${zona}`); continue; }
  escritas.push({ id: c.id, nome: c.nome, de: zonaAtual || '(vazio)', para: zona, morada: novaMorada, moradaAntes: c.morada });
}

console.log(`\n${escritas.length} clientes a acertar (${clientes.length} no total):\n`);
for (const e of escritas) {
  const m = e.morada !== e.moradaAntes ? `   morada: ${JSON.stringify(e.moradaAntes)} -> ${JSON.stringify(e.morada)}` : '';
  console.log(`  ${e.nome.padEnd(22)} ${e.de.padEnd(20)} -> ${e.para}${m ? '\n' + m : ''}`);
}

if (conflitos.length) {
  console.log(`\nMorada a rever a mao (a zona ganhou, a morada diz outra coisa):`);
  for (const c of conflitos) console.log(`  - ${c}`);
}

const forasteiras = intactos.filter((l) => l.includes('NAO TOCADA') || l.includes('sem zona'));
if (forasteiras.length) {
  console.log(`\nNao acertados:`);
  for (const l of forasteiras) console.log(`  - ${l}`);
}

if (!apply) {
  console.log(`\nSimulacao. Corre outra vez com --apply para escrever.\n`);
  process.exit(0);
}

const escrever = db.transaction(() => {
  const upd = db.prepare(`UPDATE clients SET zone = ?, address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  for (const e of escritas) upd.run(e.para, e.morada, e.id);

  const sobra = db.prepare(`
    SELECT COUNT(*) AS n FROM clients
     WHERE zone IS NULL OR TRIM(zone) = '' OR zone NOT IN (${ZONAS.map(() => '?').join(',')})
  `).get(...ZONAS).n;
  if (sobra > 0) throw new Error(`${sobra} clientes ficariam fora da lista de zonas — nada foi escrito`);
});

escrever();
const depois = db.prepare(`SELECT zone, COUNT(*) n FROM clients GROUP BY zone ORDER BY n DESC`).all();
console.log(`\nEscrito. Zonas agora:`);
for (const r of depois) console.log(`  ${String(r.n).padStart(2)}  ${r.zone}`);
console.log();

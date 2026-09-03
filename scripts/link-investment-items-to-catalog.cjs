/**
 * Liga ao catálogo os itens de investimento que são o MESMO equipamento que já
 * deu entrada no armazém.
 *
 * Até à 1.20 havia dois livros de custo que não se falavam: o armazém, escrito
 * por cada instalação, e os investimentos, escritos à mão. Quem comprou seis CPE
 * e depois registou o investimento "Expansão Achada" pagou-os duas vezes no
 * relatório, e nada no sistema o dizia. A 1.20 dá ao item de investimento um
 * `catalog_id`: preenchido, o item deixa de somar capital e passa a reclamá-lo —
 * o equipamento já contou quando entrou.
 *
 * Este script faz essa ligação só onde ela é indiscutível. Quatro pares em que
 * o investimento e o armazém dizem exatamente o mesmo, à unidade e ao escudo:
 *
 *   investimento                  item              armazém              capital
 *   Backbone Starlink             1 x 43.000$       1 Starlink Kit V4     43.000$
 *   Antenas de Clientes CPE 510  19 x  6.500$      19 CPE 510           123.500$
 *   Antenas Clientes CPE CN       8 x  5.000$       8 TL-S5-5KM           40.000$
 *   Mercusys AC12                 2 x  5.000$       2 Mercusys AC12       10.000$
 *
 * E mais quatro em que o preço do investimento não bate com o do armazém —
 * Archer C20, TL-WR850N, MW325R e CPE710. Aqui a ligação continua a ser certa, e
 * o preço é uma questão à parte: o Archer C20 tem 12 instalações e o investimento
 * só cobre 8, ou seja o modelo já mistura as duas contabilidades. Ligar torna-o
 * coerente — tudo ao preço do armazém, que é o que já governa as outras quatro
 * unidades — em vez de deixar oito a preço de investimento E contadas outra vez
 * no armazém. Por isso a quantidade não tem de bater: só se exige que o armazém
 * conheça pelo menos as unidades que o investimento reclama, senão o item está a
 * falar de outra coisa.
 *
 * O CPE710 é o único que obriga a mexer no preço antes de ligar. As suas duas
 * saídas foram criadas pela regularização de backbone da migração 0050, que não
 * gravou custo: ficaram a 0$, e a abertura de inventário da 0053, sem saída
 * valorizada onde se apoiar, cai no preço do catálogo. O catálogo dizia 15.000$ e
 * o que se pagou foram 13.000$ — corrigem-se os dois, o catálogo e a abertura,
 * porque é a abertura que carrega o capital.
 *
 * Os restantes cinco itens NÃO são tocados, de propósito:
 *   - Cabo e RJ45 estão em unidades diferentes nos dois lados (610 contra 175).
 *   - "Serrilhas e afixadores" não existe no catálogo: é custo externo genuíno e
 *     deve continuar a somar.
 *   - "Router Gestão Mikrotik" é o router da operadora, um aparelho que não está
 *     no armazém. Os dois hAP ac Lite instalados são dos CLIENTES (propriedade
 *     `cliente`, renda 0) e não são capital do ISP. Ligá-los seria colar coisas
 *     diferentes com o mesmo modelo e perder 8.000$ de capital real.
 *
 * Cuidados:
 *   - exige a 1.20 instalada (a coluna `catalog_id` nasce na migração 0054);
 *   - cada par é verificado antes de escrever — nome do item, quantidade, custo
 *     unitário e as unidades que o armazém conhece. Se um só não bater, não se
 *     escreve NADA: ou o lote todo confere, ou aborta;
 *   - idempotente: um item já ligado é saltado, e um preço já corrigido também;
 *   - corre dentro de uma transação e deixa registo na auditoria.
 *
 * Uso:
 *   node scripts/link-investment-items-to-catalog.cjs            # simulação
 *   node scripts/link-investment-items-to-catalog.cjs --apply    # escreve
 *
 * FAÇA O BACKUP ANTES DE CORRER COM --apply.
 */
const Database = require('better-sqlite3');
const os = require('node:os');
const path = require('node:path');

const apply = process.argv.includes('--apply');
const dataDir = process.env.ISPM_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
  'ISPM'
);

/**
 * Os quatro pares, identificados pelo que são e não por id.
 *
 * Um id de item é frágil — basta reeditar o investimento na aplicação para as
 * linhas serem reescritas com ids novos. O par identifica-se pelo nome do
 * investimento e do item, e todo o resto é verificado antes de escrever.
 */
const PARES = [
  { investimento: 'Backbone Starlink', item: 'Antena Starlink Standart — Starlink', marca: 'Starlink', modelo: 'Kit Antena Standart V4', qtd: 1, unitCve: 43000 },
  { investimento: 'Antenas de Clientes CPE 510', item: 'Antenas CPE', marca: 'TP-Link', modelo: 'CPE 510 Ponto de Acesso para Exterior WiFi 300 Mbps', qtd: 19, unitCve: 6500 },
  { investimento: 'Antenas Clientes CPE CN', item: 'Antenas Chinesas', marca: 'Tp-Link CN', modelo: 'TL-S5-5KM', qtd: 8, unitCve: 5000 },
  { investimento: 'Mercusys AC12 Router WIFI Dual Band AC1200', item: 'Mercusys AC12 Router WIFI Dual Band AC1200', marca: 'Mercusys', modelo: 'AC12 Router WIFI Dual Band AC1200', qtd: 2, unitCve: 5000 }
];

/**
 * Segunda leva: a ligação é certa, o preço do investimento é que difere do
 * armazém. `minimoArmazem` em vez de `qtd` — ver o cabeçalho. `corrigeCatalogo`
 * só onde o preço do catálogo está comprovadamente errado.
 */
const PARES_PRECO_DIVERGENTE = [
  { investimento: 'Router TP-Link Archer C20 V4  WiFi AC750 Dual Band', item: 'Router TP-Link Archer C20 V4  WiFi AC750 Dual Band', marca: 'TP-Link', modelo: 'Archer C20 Wireless Router Dual-Band', minimoArmazem: 8 },
  { investimento: 'TP-Link TL-WR850N Router WIFI Branco', item: 'TP-Link TL-WR850N Router WIFI Branco', marca: 'TP-Link', modelo: 'TL-WR850N Router WIFI Branco', minimoArmazem: 8 },
  { investimento: 'Mercusys MW325R Router Wi-Fi N 300Mbps', item: 'Mercusys MW325R Router Wi-Fi N 300Mbps', marca: 'Mercusys', modelo: 'MW325R Router Wi-Fi N 300Mbps', minimoArmazem: 1 },
  { investimento: 'Antenas 710 Transmissao', item: 'Equipamento', marca: 'TP-Link', modelo: 'CPE710 Antena WiFi Exterior 5GHz AC 867Mbps PoE 23dBi', minimoArmazem: 2, corrigeCatalogo: { deCve: 15000, paraCve: 13000 } }
];

const cve = (v) => new Intl.NumberFormat('pt-PT').format(Math.round(v)) + '$00';

const db = new Database(path.join(dataDir, 'ispm.sqlite'));
db.pragma('foreign_keys = ON');

// --------------------------------------------------------------- pré-requisitos

const temColuna = db.prepare(`PRAGMA table_info(investment_items)`).all()
  .some((c) => c.name === 'catalog_id');
if (!temColuna) {
  console.error('Esta base ainda não tem a coluna `catalog_id` em investment_items.');
  console.error('Instale a versão 1.20 primeiro — a migração 0054 é que a cria — e volte a correr.');
  db.close();
  process.exit(1);
}

const LANDED = '(purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)';

/** Unidades que o armazém sabe que foram adquiridas deste modelo. */
function adquiridas(catalogId) {
  const r = db.prepare(`
    SELECT ec.stock_total
      + COALESCE((SELECT SUM(abs(quantity)) FROM stock_movements m WHERE m.catalog_id = ec.id AND m.type = 'saida'), 0)
      - COALESCE((SELECT SUM(quantity) FROM stock_movements m WHERE m.catalog_id = ec.id AND m.type = 'devolucao'), 0)
      - COALESCE((SELECT SUM(quantity) FROM stock_movements m WHERE m.catalog_id = ec.id AND m.type = 'ajuste'), 0)
      AS qtd
    FROM equipment_catalog ec WHERE ec.id = ?
  `).get(catalogId);
  return Number(r?.qtd) || 0;
}

// --------------------------------------------------------------- verificação

const plano = [];
const problemas = [];
let jaLigados = 0;

for (const par of PARES) {
  const item = db.prepare(`
    SELECT it.id, it.item_name AS nome, it.quantity AS qtd, it.unit_cost_cve AS unit,
           it.total_cost_cve AS total, it.catalog_id AS catalogId,
           i.id AS invId, i.name AS inv
    FROM investment_items it
    JOIN investments i ON i.id = it.investment_id
    WHERE i.name = ? AND it.item_name = ?
  `).all(par.investimento, par.item);

  if (item.length === 0) { problemas.push(`"${par.investimento}" / "${par.item}": item não encontrado`); continue; }
  if (item.length > 1) { problemas.push(`"${par.investimento}" / "${par.item}": ${item.length} itens com o mesmo nome — desfaça a ambiguidade à mão`); continue; }
  const it = item[0];

  if (it.catalogId != null) { jaLigados++; continue; }

  // Marca e modelo vivem em colunas separadas — a etiqueta que se vê na
  // aplicação é a junção das duas, e é essa que o par nomeia.
  const modelo = db.prepare(`
    SELECT id, brand, model, ${LANDED} AS landed FROM equipment_catalog
    WHERE brand = ? AND model = ?
  `).all(par.marca, par.modelo);
  if (modelo.length !== 1) {
    problemas.push(`"${par.marca} ${par.modelo}": ${modelo.length} modelos com este nome no catálogo`);
    continue;
  }
  const mod = modelo[0];
  const etiqueta = [mod.brand, mod.model].filter(Boolean).join(' ');

  // O par só é indiscutível se TUDO bater: quantidade, custo unitário, o custo
  // do catálogo e as unidades que o armazém conhece.
  if (Number(it.qtd) !== par.qtd) problemas.push(`"${par.item}": quantidade ${it.qtd}, esperava ${par.qtd}`);
  if (Number(it.unit) !== par.unitCve) problemas.push(`"${par.item}": custo unitário ${cve(it.unit)}, esperava ${cve(par.unitCve)}`);
  if (Number(mod.landed) !== par.unitCve) problemas.push(`"${etiqueta}": custo do catálogo ${cve(mod.landed)}, esperava ${cve(par.unitCve)}`);
  const adq = adquiridas(mod.id);
  if (adq !== par.qtd) problemas.push(`"${etiqueta}": armazém conhece ${adq} unidades, o investimento reclama ${par.qtd}`);

  plano.push({ itemId: it.id, invId: it.invId, inv: it.inv, item: it.nome, modeloId: mod.id, modelo: etiqueta, total: Number(it.total) });
}

const correcoes = [];

for (const par of PARES_PRECO_DIVERGENTE) {
  const item = db.prepare(`
    SELECT it.id, it.item_name AS nome, it.quantity AS qtd, it.total_cost_cve AS total,
           it.catalog_id AS catalogId, i.id AS invId, i.name AS inv
    FROM investment_items it
    JOIN investments i ON i.id = it.investment_id
    WHERE i.name = ? AND it.item_name = ?
  `).all(par.investimento, par.item);

  if (item.length === 0) { problemas.push(`"${par.investimento}" / "${par.item}": item nao encontrado`); continue; }
  if (item.length > 1) { problemas.push(`"${par.investimento}" / "${par.item}": ${item.length} itens com o mesmo nome`); continue; }
  const it = item[0];
  if (it.catalogId != null) { jaLigados++; continue; }

  const modelo = db.prepare(`
    SELECT id, brand, model, purchase_price_cve AS compra, ${LANDED} AS landed
    FROM equipment_catalog WHERE brand = ? AND model = ?
  `).all(par.marca, par.modelo);
  if (modelo.length !== 1) {
    problemas.push(`"${par.marca} ${par.modelo}": ${modelo.length} modelos com este nome no catalogo`);
    continue;
  }
  const mod = modelo[0];
  const etiqueta = [mod.brand, mod.model].filter(Boolean).join(' ');

  // A quantidade nao tem de bater — o investimento etiqueta parte das compras.
  // Mas se o armazem conhece MENOS unidades do que o investimento reclama, entao
  // o item esta a falar de outro equipamento e nao se toca nele.
  const adq = adquiridas(mod.id);
  if (adq < par.minimoArmazem) {
    problemas.push(`"${etiqueta}": armazem conhece ${adq} unidades, o investimento reclama ${par.minimoArmazem}`);
    continue;
  }

  if (par.corrigeCatalogo) {
    const { deCve, paraCve } = par.corrigeCatalogo;
    if (Number(mod.compra) === deCve) {
      correcoes.push({ modeloId: mod.id, modelo: etiqueta, deCve, paraCve });
    } else if (Number(mod.compra) !== paraCve) {
      problemas.push(`"${etiqueta}": preco de compra ${cve(mod.compra)}, esperava ${cve(deCve)} para corrigir (ou ${cve(paraCve)} ja corrigido)`);
      continue;
    }
  }

  plano.push({ itemId: it.id, invId: it.invId, inv: it.inv, item: it.nome, modeloId: mod.id, modelo: etiqueta, total: Number(it.total) });
}

// --------------------------------------------------------------- relatório

if (jaLigados > 0) console.log(`${jaLigados} item(s) já estavam ligados — saltados.\n`);

if (problemas.length > 0) {
  console.error('Não escrevo nada. O que não confere:\n');
  for (const p of problemas) console.error('  - ' + p);
  console.error('\nOu o lote todo bate, ou não se toca em nada: metade ligado é pior que nada,');
  console.error('porque deixa o capital num estado que ninguém consegue explicar.');
  db.close();
  process.exit(1);
}

if (plano.length === 0 && correcoes.length === 0) {
  console.log('Nada a fazer.');
  db.close();
  process.exit(0);
}

if (correcoes.length > 0) {
  console.log('Precos do catalogo a corrigir antes de ligar:\n');
  for (const c of correcoes) {
    console.log(`  catalogo #${c.modeloId} ${c.modelo}:  ${cve(c.deCve)} -> ${cve(c.paraCve)}`);
    console.log('         (e a abertura de inventario deste modelo, se ja existir)');
  }
  console.log('');
}

console.log('Itens a ligar ao catálogo (deixam de somar capital — já contam pelo armazém):\n');
for (const p of plano) {
  console.log(`  #${p.itemId}  "${p.item}"  do investimento "${p.inv}"`);
  console.log(`         → catálogo #${p.modeloId} ${p.modelo}   ${cve(p.total)}`);
}
const totalCve = plano.reduce((s, p) => s + p.total, 0);

const capitalAntes = db.prepare(`
  SELECT COALESCE(SUM(
    CASE WHEN EXISTS (SELECT 1 FROM investment_items it WHERE it.investment_id = i.id)
      THEN COALESCE((SELECT SUM(it.total_cost_cve) FROM investment_items it
                     WHERE it.investment_id = i.id AND it.catalog_id IS NULL), 0)
      ELSE i.total_cost_cve END), 0) AS v
  FROM investments i
`).get().v;

console.log(`\nCapital externo dos investimentos: ${cve(capitalAntes)} → ${cve(capitalAntes - totalCve)}`);
console.log(`Dupla contagem removida: ${cve(totalCve)}`);

if (!apply) {
  console.log('\nSimulação. Faça o backup e corra com --apply para escrever.');
  db.close();
  process.exit(0);
}

// --------------------------------------------------------------- escrita

const escrever = db.transaction(() => {
  const liga = db.prepare(`UPDATE investment_items SET catalog_id = ? WHERE id = ? AND catalog_id IS NULL`);
  const corrigePreco = db.prepare(`
    UPDATE equipment_catalog SET purchase_price_cve = ?, updated_at = datetime('now')
    WHERE id = ? AND purchase_price_cve = ?
  `);
  // A abertura carrega o capital: corrigir so o catalogo deixava-a com o preco
  // velho e o numero continuava errado.
  const corrigeAbertura = db.prepare(`
    UPDATE stock_movements SET unit_cost_cve = ?
    WHERE catalog_id = ? AND type = 'entrada' AND reference = 'Abertura de inventario'
      AND unit_cost_cve = ?
  `);
  const auditaModelo = db.prepare(`
    INSERT INTO audit_logs (actor_username, actor_role, action, entity_type, entity_id, summary, metadata_json, created_at)
    VALUES ('script', 'admin', 'update', 'equipment_catalog', ?, ?, ?, datetime('now'))
  `);
  for (const c of correcoes) {
    const r = corrigePreco.run(c.paraCve, c.modeloId, c.deCve);
    if (r.changes !== 1) throw new Error(`preco do modelo #${c.modeloId} nao foi corrigido — mudou debaixo dos pes?`);
    const ab = corrigeAbertura.run(c.paraCve, c.modeloId, c.deCve);
    auditaModelo.run(
      String(c.modeloId),
      `Custo de compra corrigido de ${cve(c.deCve)} para ${cve(c.paraCve)}`,
      JSON.stringify({ deCve: c.deCve, paraCve: c.paraCve, aberturasCorrigidas: ab.changes, script: 'link-investment-items-to-catalog' })
    );
  }
  const audita = db.prepare(`
    INSERT INTO audit_logs (actor_username, actor_role, action, entity_type, entity_id, summary, metadata_json, created_at)
    VALUES ('script', 'admin', 'update', 'investment_item', ?, ?, ?, datetime('now'))
  `);
  for (const p of plano) {
    const r = liga.run(p.modeloId, p.itemId);
    if (r.changes !== 1) throw new Error(`item #${p.itemId} não foi ligado — mudou debaixo dos pés?`);
    audita.run(
      String(p.itemId),
      `Item "${p.item}" ligado ao catálogo #${p.modeloId} ${p.modelo}`,
      JSON.stringify({ investmentId: p.invId, catalogId: p.modeloId, totalCve: p.total, script: 'link-investment-items-to-catalog' })
    );
  }
});

escrever();
if (correcoes.length > 0) console.log(`\n${correcoes.length} preco(s) de catalogo corrigido(s).`);
console.log(`${plano.length} item(s) ligados. Capital externo agora: ${cve(capitalAntes - totalCve)}`);
db.close();

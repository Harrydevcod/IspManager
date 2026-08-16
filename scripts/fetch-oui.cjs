#!/usr/bin/env node
/**
 * Gera `src/backend/lib/oui-data.ts` a partir do registo oficial do IEEE.
 *
 * A descoberta de rede mostra o fabricante de cada equipamento a partir dos
 * primeiros três octetos do MAC. Um mapa escrito à mão não serve: numa rede
 * real deste ISP, 21 prefixos distintos aparecem numa única leitura da tabela
 * ARP, e nenhum deles é adivinhável — a lista tem de vir da fonte.
 *
 * Corre-se à mão quando se quiser atualizar (o registo cresce devagar) e o
 * resultado é commitado. A aplicação nunca vai à Internet buscar isto: é um
 * ERP que trabalha offline.
 *
 *   node scripts/fetch-oui.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCES = [
  'https://standards-oui.ieee.org/oui/oui.csv',
  'https://raw.githubusercontent.com/silverwind/oui/master/oui.json'
];

const OUT = path.join(__dirname, '..', 'src', 'backend', 'lib', 'oui-data.ts');

/**
 * Nomes longos não cabem numa coluna de tabela — e ninguém lê "TP-LINK
 * TECHNOLOGIES CO. LTD." inteiro para perceber que é um TP-Link.
 *
 * A limpeza da pontuação a seguir ao corte das palavras não é cosmética: sem
 * ela sobram restos como "TP-Link ." e "MERCUSYS . .", porque o que se corta
 * são as palavras e os pontos que as acompanhavam ficam para trás.
 */
function tidy(name) {
  return name
    .replace(/[",]/g, ' ')
    .replace(/\b(Co\.?|Corp\.?|Corporation|Inc\.?|Ltd\.?|Limited|LLC|GmbH|S\.A\.|B\.V\.|Pty|Company|Technologies|Technology|Electronics|Communications?|Networks?|International|Industrial|Systems?)\b/gi, ' ')
    .replace(/\s*[.\-–—]\s*(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:\-–—]+$/, '')
    .replace(/^[\s.,;:\-–—]+/, '')
    .trim()
    .slice(0, 28)
    .replace(/[\s.,;:\-–—]+$/, '') || null;
}

function parseCsv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    // Registry,Assignment,Organization Name,Organization Address
    const match = /^[^,]*,([0-9A-Fa-f]{6}),(?:"([^"]*)"|([^,]*)),/.exec(line);
    if (!match) continue;
    const prefix = match[1].toUpperCase();
    const name = tidy(match[2] ?? match[3] ?? '');
    if (name) out.set(prefix, name);
  }
  return out;
}

function parseJson(text) {
  const out = new Map();
  for (const [key, value] of Object.entries(JSON.parse(text))) {
    const prefix = key.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6).toUpperCase();
    const name = tidy(String(value).split('\n')[0]);
    if (prefix.length === 6 && name) out.set(prefix, name);
  }
  return out;
}

async function main() {
  let entries = null;
  for (const url of SOURCES) {
    try {
      process.stdout.write(`A obter ${url}\n`);
      const response = await fetch(url, { headers: { 'user-agent': 'ispm-oui-generator' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      entries = url.endsWith('.csv') ? parseCsv(text) : parseJson(text);
      if (entries.size > 1000) break;
      entries = null;
    } catch (err) {
      process.stdout.write(`  falhou: ${err.message}\n`);
    }
  }

  if (!entries) {
    process.stderr.write('Nenhuma fonte respondeu. O ficheiro atual fica intacto.\n');
    process.exit(1);
  }

  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
  // `JSON.stringify` escapa aspas, plicas, barras e acentuações — nomes de
  // fabricante trazem tudo isso, e uma plica solta parte o ficheiro gerado.
  const body = JSON.stringify(sorted.map(([prefix, name]) => `${prefix}\t${name}`).join('\n'));

  fs.writeFileSync(OUT, `/* eslint-disable */
// GERADO por scripts/fetch-oui.cjs a partir do registo OUI do IEEE.
// Não editar à mão — voltar a correr o script para atualizar.
// ${sorted.length} prefixos.

/**
 * Uma string única em vez de um objeto: ${sorted.length} chaves literais fazem o
 * parser de TypeScript e o bundler trabalharem em cada build, e a tabela é lida
 * uma vez por arranque. Formato: PREFIXO<TAB>fabricante, um por linha.
 */
const RAW = ${body};

let table: Map<string, string> | null = null;

export function ouiTable(): Map<string, string> {
  if (table) return table;
  table = new Map();
  for (const line of RAW.split('\\n')) {
    const tab = line.indexOf('\\t');
    if (tab === 6) table.set(line.slice(0, 6), line.slice(tab + 1));
  }
  return table;
}
`, 'utf8');

  process.stdout.write(`Escrito ${OUT} com ${sorted.length} prefixos.\n`);
}

void main();

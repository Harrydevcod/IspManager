#!/usr/bin/env node
/* eslint-disable */
/**
 * Fase 0, do lado do router: **que campos é que o MikroTik tem preenchidos?**
 *
 * A Descoberta pede hoje quatro campos das concessões DHCP e seis dos vizinhos
 * (`routeros.ts`, os `.proplist`). O router tem mais para dar no mesmo pedido,
 * de graça — o `comment`, que é onde os operadores escrevem o nome do cliente, e
 * o `active-host-name`, que às vezes está preenchido quando o `host-name` não
 * está.
 *
 * "De graça" não é razão para o ir buscar. A razão é ter lá dados, e é isso que
 * este script conta. Se o `comment` vier vazio em toda a linha, a coluna que ele
 * ia justificar não se constrói.
 *
 * Pede **sem `.proplist`**, de propósito: é a única maneira de ver os campos que
 * ninguém pensou em pedir.
 *
 * Só lê. Não escreve na base de dados nem toca em nada no router.
 *
 *   node scripts/probe-router-fields.cjs
 *   node scripts/probe-router-fields.cjs --out C:\\tmp\\campos.json
 */

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const REQUEST_TIMEOUT_MS = 8000;

/** Os mesmos caminhos que a Descoberta usa, sem o `.proplist` que os estreita. */
const PATHS = [
  '/ip/dhcp-server/lease',
  '/ip/arp',
  '/ip/neighbor'
];

// ------------------------------------------------------------- configuração

function openDb() {
  const dataDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), '.local', 'share'),
    'ispm'
  );
  return new Database(path.join(dataDir, 'ispm.sqlite'), { readonly: true });
}

function readConfig(db) {
  const get = (key) => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value ?? '';
  };
  return {
    host: get('routerosHost'),
    port: Number(get('routerosPort')) || 443,
    user: get('routerosUser'),
    password: get('routerosPassword'),
    tlsCert: get('routerosTlsCert')
  };
}

/**
 * O mesmo transporte do `createTransport`, reduzido ao GET.
 *
 * A fixação do certificado é copiada de propósito: um script de medição que
 * aceitasse qualquer certificado ensinaria a fazer isso, e as credenciais do
 * router saem por aqui na mesma.
 */
function get(config, apiPath) {
  const pinned = config.tlsCert.trim();
  const fingerprint = pinned
    ? new crypto.X509Certificate(pinned).fingerprint256.toUpperCase()
    : '';

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: config.host,
        port: config.port,
        path: `/rest${apiPath}`,
        method: 'GET',
        auth: `${config.user}:${config.password}`,
        rejectUnauthorized: true,
        ...(pinned
          ? {
              ca: [pinned],
              checkServerIdentity: (_host, cert) =>
                cert.fingerprint256?.toUpperCase() === fingerprint
                  ? undefined
                  : new Error('O certificado do router nao e o que esta fixado')
            }
          : {}),
        timeout: REQUEST_TIMEOUT_MS,
        headers: { accept: 'application/json' }
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`${apiPath}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`${apiPath}: resposta ilegivel`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${apiPath}: sem resposta`)));
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------------------------ contagem

/**
 * Quantas linhas trazem cada campo com conteúdo.
 *
 * Um campo presente e vazio conta como ausente — é a mesma coisa para quem
 * queria mostrá-lo no ecrã.
 */
function countFields(rows) {
  const counts = new Map();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const filled = value !== null && value !== undefined && String(value).trim() !== '';
      if (!filled) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outPath = outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : path.join('.scratch', `router-fields-${stamp}.json`);

  const db = openDb();
  const config = readConfig(db);
  db.close();

  if (!config.host || !config.user) {
    console.error('Router de gestão não configurado (Definições › Rede). Nada para medir.');
    process.exit(1);
  }
  console.log(`Router ${config.host}:${config.port}\n`);

  const collected = {};
  for (const apiPath of PATHS) {
    let rows;
    try {
      rows = await get(config, apiPath);
    } catch (error) {
      console.log(`${apiPath}\n  falhou: ${error.message}\n`);
      continue;
    }
    collected[apiPath] = rows;

    console.log(`${apiPath} — ${rows.length} linhas`);
    for (const [field, filled] of countFields(rows)) {
      console.log(`  ${field.padEnd(24)} ${filled}/${rows.length}`);
    }
    console.log('');
  }

  // O cruzamento que interessa: o `active-host-name` só vale a pena se
  // preencher onde o `host-name` está vazio. Se aparecerem sempre juntos, é uma
  // segunda coluna a dizer o mesmo.
  const leases = collected['/ip/dhcp-server/lease'] ?? [];
  const semNome = leases.filter((row) => !String(row['host-name'] ?? '').trim());
  const salvos = semNome.filter((row) => String(row['active-host-name'] ?? '').trim());
  const comNota = leases.filter((row) => String(row.comment ?? '').trim());
  console.log('O que decide a etapa 1b:');
  console.log(`  concessões sem host-name:            ${semNome.length}/${leases.length}`);
  console.log(`  dessas, com active-host-name:        ${salvos.length}`);
  console.log(`  concessões com comment (nota):       ${comNota.length}/${leases.length}`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ at: stamp, collected }, null, 2), 'utf8');
  console.log(`\nEscrito: ${outPath}`);
  console.log('Contém credenciais? Não — só as linhas do router. Mas contém a rede toda.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Prepara a pasta de dados do `npm run dev` com uma cópia da base instalada.
 *
 *   node scripts/seed-dev-data.cjs            copia só se a pasta dev ainda não tiver base
 *   node scripts/seed-dev-data.cjs --refresh  volta a copiar por cima (perde o que se fez em dev)
 *
 * A base de produção só é lida. A cópia faz-se pela API de backup do SQLite, que
 * dá um ficheiro coerente mesmo com a app instalada aberta e a escrever em WAL.
 */
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.env.APPDATA || os.homedir();
const source = path.join(root, 'ISPM');
// O mesmo nome que `resolveDataDir()` usa com NODE_ENV=development.
const target = path.join(root, 'ISPM-dev');
const sourceDb = path.join(source, 'ispm.sqlite');
const targetDb = path.join(target, 'ispm.sqlite');
const refresh = process.argv.includes('--refresh');

async function main() {
  if (fs.existsSync(targetDb) && !refresh) return;
  if (!fs.existsSync(sourceDb)) {
    console.log('[dev] Sem base instalada para copiar: o dev arranca com uma base vazia.');
    return;
  }

  fs.mkdirSync(target, { recursive: true });
  try {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(targetDb + suffix, { force: true });
  } catch {
    console.error('[dev] A base de desenvolvimento está aberta. Feche o `npm run dev` e repita.');
    process.exit(1);
  }

  const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try {
    await db.backup(targetDb);
  } finally {
    db.close();
  }

  const license = path.join(source, 'license.json');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(target, 'license.json'));
  console.log(`[dev] Base copiada para ${target}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

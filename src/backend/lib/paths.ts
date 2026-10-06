import os from 'node:os';
import path from 'node:path';

/** Single source of the on-disk data directory. Mirrors the historical
 *  inline logic from database.ts so backups and the DB never disagree. */
export function resolveDataDir(): string {
  // Um teste que chega aqui sem pasta própria abria a base de produção e
  // aplicava-lhe as migrações por lançar. Rebenta em vez de a tocar.
  if (process.env.VITEST && !process.env.ISPM_DATA_DIR) {
    throw new Error('Teste sem ISPM_DATA_DIR: ia abrir a base de dados real. Defina uma pasta temporária antes de usar a base.');
  }
  return (
    process.env.ISPM_DATA_DIR
    || path.join(process.env.APPDATA || os.homedir(), 'ISPM')
  );
}

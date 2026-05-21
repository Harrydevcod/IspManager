import os from 'node:os';
import path from 'node:path';

/** Single source of the on-disk data directory. Mirrors the historical
 *  inline logic from database.ts so backups and the DB never disagree. */
export function resolveDataDir(): string {
  return (
    process.env.ISPM_DATA_DIR
    || path.join(process.env.APPDATA || os.homedir(), 'ISPM')
  );
}

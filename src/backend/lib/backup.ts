import Database from 'better-sqlite3';
import {
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
  copyFileSync,
  renameSync,
  accessSync,
  constants,
} from 'node:fs';
import path from 'node:path';
import { getSqliteDatabase, closeDatabase } from '../db/database';
import { resolveDataDir } from './paths';

export interface BackupEntry {
  /** Filename only (not a full path). */
  file: string;
  createdAt: Date;
  sizeBytes: number;
}

const DAILY_WINDOW_DAYS = 14;
const WEEKLY_WINDOW_WEEKS = 8;

function isPreRestore(file: string): boolean {
  return file.startsWith('pre-restore-');
}

// Retention day/week buckets are computed in the host machine's LOCAL
// timezone by design (a desktop app's "calendar day" is the operator's
// local day). isoWeekKey below normalizes to UTC only to make the ISO
// week-number arithmetic stable; the resulting week label is still keyed
// off the local-date components passed in.
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

/** Returns the entries that should be DELETED. Pure: no filesystem access.
 *  Keeps the newest entry per calendar day within the last 14 days; from
 *  entries older than that window, keeps the newest per ISO week for up to
 *  the 8 most recent weekly buckets; prunes everything else. pre-restore-* snapshots are never
 *  selected (disaster-recovery evidence, rare). */
export function selectForRetention(entries: BackupEntry[], now: Date): BackupEntry[] {
  const managed = entries.filter((e) => !isPreRestore(e.file));
  const sorted = [...managed].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const dailyCutoff = new Date(now);
  dailyCutoff.setDate(dailyCutoff.getDate() - DAILY_WINDOW_DAYS);

  const keep = new Set<BackupEntry>();
  const seenDay = new Set<string>();
  const weekly: BackupEntry[] = [];

  for (const e of sorted) {
      // Inclusive (>=) on purpose: an entry exactly at the cutoff is KEPT
      // (daily branch), never deleted. Do not "fix" this to a strict <.
    if (e.createdAt.getTime() >= dailyCutoff.getTime()) {
      const k = dayKey(e.createdAt);
      if (!seenDay.has(k)) {
        seenDay.add(k);
        keep.add(e);
      }
    } else {
      weekly.push(e);
    }
  }

  const seenWeek = new Set<string>();
  for (const e of weekly) {
    const k = isoWeekKey(e.createdAt);
    // Keeps the 8 MOST RECENT weekly buckets (input is sorted newest-first),
    // i.e. a count of buckets, not a fixed calendar window.
    if (!seenWeek.has(k) && seenWeek.size < WEEKLY_WINDOW_WEEKS) {
      seenWeek.add(k);
      keep.add(e);
    }
  }

  return managed.filter((e) => !keep.has(e));
}

const FILE_RE = /^(?:ispm|pre-restore)-(\d{8})-(\d{6})\.sqlite$/;

function settingsBackupDir(): string | null {
  const db = getSqliteDatabase();
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('backupDir') as { value: string } | undefined;
  const raw = row?.value?.trim();
  return raw && raw.length > 0 ? raw : null;
}

// CONTRACT: resolveBackupDir() reads app_settings via getSqliteDatabase(),
// which LAZILY (RE)OPENS + re-migrates the live DB if it is currently
// closed. Any flow that closes the DB (restore) MUST resolve all needed
// directories BEFORE closeDatabase() and must NOT call resolveBackupDir()
// or pruneBackups() after the connection is closed, or it will resurrect
// the connection on a file that may be mid-swap.
export function resolveBackupDir(): string {
  const configured = settingsBackupDir();
  const dir = configured || path.join(resolveDataDir(), 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function parseStamp(file: string): Date | null {
  const m = FILE_RE.exec(file);
  if (!m) return null;
  const [, d, t] = m;
  return new Date(
    Number(d.slice(0, 4)),
    Number(d.slice(4, 6)) - 1,
    Number(d.slice(6, 8)),
    Number(t.slice(0, 2)),
    Number(t.slice(2, 4)),
    Number(t.slice(4, 6)),
  );
}

/**
 * Valida uma pasta de destino de backups (ex.: pasta sincronizada Drive/Dropbox/
 * OneDrive = "destino externo"). Vazio = usar a pasta por defeito (válido).
 * Devolve a mensagem de erro ou null. Partilhado pelo PUT /api/settings e pelo
 * endpoint de configuração de backups.
 */
export function validateBackupDir(dir: string): string | null {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return null;
  try {
    if (!existsSync(trimmed) || !statSync(trimmed).isDirectory()) {
      return 'Pasta de backups inexistente';
    }
    accessSync(trimmed, constants.W_OK);
  } catch {
    return 'Pasta de backups sem permissão de escrita';
  }
  return null;
}

const BACKUP_INTERVAL_KEY = 'backupIntervalHours';

/** Intervalo de backup automático em horas; 0 (ou ausente) = agendamento desligado. */
export function readBackupIntervalHours(): number {
  const row = getSqliteDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(BACKUP_INTERVAL_KEY) as { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Backup agendado idempotente (mesmo padrão "IfDue" da auto-faturação): cria um
 * backup apenas se já passou `backupIntervalHours` desde o último backup `ispm-*`.
 * O arranque já garante um backup por sessão; este cobre sessões longas. Os
 * snapshots `pre-restore-*` (recuperação) não contam para a cadência.
 */
export async function runScheduledBackupIfDue(
  now: Date = new Date(),
): Promise<{ ran: true; file: string } | { skipped: string }> {
  const intervalHours = readBackupIntervalHours();
  if (intervalHours <= 0) {
    return { skipped: 'agendamento desligado' };
  }
  const newest = listBackups().find((e) => e.file.startsWith('ispm-'));
  if (newest && now.getTime() - newest.createdAt.getTime() < intervalHours * 3_600_000) {
    return { skipped: 'ainda dentro do intervalo' };
  }
  const entry = await createBackup('scheduled');
  pruneBackups();
  return { ran: true, file: entry.file };
}

export async function createBackup(
  reason: 'startup' | 'manual' | 'scheduled',
): Promise<BackupEntry> {
  void reason; // kept for future audit-log divergence; retention is uniform
  const dir = resolveBackupDir();
  const now = new Date();
  const file = `ispm-${stamp(now)}.sqlite`;
  const dest = path.join(dir, file);
  try {
    await getSqliteDatabase().backup(dest);
    // db.backup() of a WAL-mode source yields a WAL-header file; any later
    // open (validate/restore) — even read-only — then spawns -wal/-shm
    // sidecars beside it that a read-only connection cannot checkpoint away
    // on close, leaving litter and a stale-WAL footgun next to the backup.
    // Normalising to a rollback journal makes the backup a truly
    // self-contained single file that needs no sidecars to be opened.
    const snap = new Database(dest);
    try {
      snap.pragma('journal_mode = DELETE');
    } finally {
      snap.close();
    }
  } catch (err) {
    for (const p of [dest, `${dest}-wal`, `${dest}-shm`]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
    throw err;
  }
  return { file, createdAt: now, sizeBytes: statSync(dest).size };
}

export function listBackups(): BackupEntry[] {
  const dir = resolveBackupDir();
  return readdirSync(dir)
    .map((file) => {
      const createdAt = parseStamp(file);
      if (!createdAt) return null;
      return {
        file,
        createdAt,
        sizeBytes: statSync(path.join(dir, file)).size,
      } as BackupEntry;
    })
    .filter((e): e is BackupEntry => e !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// Resolves the backup dir (see resolveBackupDir CONTRACT) — do not call mid-restore after closeDatabase().
export function pruneBackups(): void {
  const dir = resolveBackupDir();
  for (const e of selectForRetention(listBackups(), new Date())) {
    rmSync(path.join(dir, e.file), { force: true });
  }
}

export function validateBackup(file: string): { ok: boolean; reason?: string } {
  if (!existsSync(file)) return { ok: false, reason: 'Ficheiro inexistente' };
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    // A locked OR corrupt DB makes this pragma (or the prepare below)
    // throw; that is intentional — it falls through to the catch and
    // returns { ok: false }, which is the correct safe verdict.
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      return { ok: false, reason: 'Integridade do ficheiro falhou' };
    }
    const migrated = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`,
      )
      .get();
    if (!migrated) {
      return { ok: false, reason: 'Backup sem schema_migrations' };
    }
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    if (n.n < 1) {
      return { ok: false, reason: 'schema_migrations vazio' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    db?.close();
  }
}

/** Validates `file`, takes a CONSISTENT online snapshot of the current DB
 *  (db.backup(), WAL-safe) to a pre-restore-* file, closes the connection,
 *  removes the old DB's stale WAL/SHM, then atomically swaps the SQLite
 *  file (temp + rename). The caller MUST relaunch the app afterwards; on
 *  next boot getDatabase() reopens and re-migrates the restored file.
 *
 *  Ordering (see resolveBackupDir CONTRACT): validation, path resolution
 *  and the snapshot all happen BEFORE closeDatabase(); after the close only
 *  raw fs ops on already-resolved paths are used.
 *
 *  Residual crash window: if the process dies AFTER renameSync the restored
 *  DB is intact; if it dies during the temp copy, the orphan temp file is
 *  harmless and ispm.sqlite is untouched. In every case `snapshotPath` is a
 *  consistent recovery copy. Do NOT retry on failure — relaunch the app and
 *  recover from the snapshot if needed. Post-close fs failures (sidecar
 *  removal, temp cleanup, copy, rename) are rethrown wrapped with the
 *  snapshotPath location and original error as `cause` for operator recovery. */
export async function restoreBackup(
  file: string,
): Promise<{ restartRequired: true; snapshotPath?: string }> {
  const check = validateBackup(file);
  if (!check.ok) {
    throw new Error(`Backup inválido: ${check.reason}`);
  }

  const dataDir = resolveDataDir();
  const livePath = path.join(dataDir, 'ispm.sqlite');
  const backupDir = resolveBackupDir();

  let snapshotPath: string | undefined;
  if (existsSync(livePath)) {
    snapshotPath = path.join(
      backupDir,
      `pre-restore-${stamp(new Date())}.sqlite`,
    );
    await getSqliteDatabase().backup(snapshotPath);
  }

  closeDatabase();

  try {
    for (const side of ['-wal', '-shm']) {
      const p = `${livePath}${side}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }

    const tmp = path.join(dataDir, '.ispm.restore.tmp');
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    copyFileSync(file, tmp);
    renameSync(tmp, livePath);
  } catch (err) {
    const where = snapshotPath
      ? `Cópia de segurança pré-restauro em: ${snapshotPath}`
      : 'Sem cópia pré-restauro (não existia base de dados).';
    throw new Error(
      `Falha ao concluir o restauro; a base de dados pode estar inconsistente. ` +
        `Feche a aplicação e recupere manualmente se necessário. ${where}`,
      { cause: err as Error },
    );
  }

  return { restartRequired: true, snapshotPath };
}

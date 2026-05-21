import type { Migration } from './types';
import m0001 from './0001_initial_schema';
import m0002 from './0002_work_orders';
import m0003 from './0003_audit_logs';
import m0004 from './0004_payments_status_check';

/**
 * The migration chain, in the order new migrations are appended.
 * The runner sorts by `version` defensively, but keep this list ordered.
 *
 * To evolve the schema: add `NNNN_description.ts` exporting a `Migration` with
 * the next version number and append it here. Never edit a shipped migration —
 * the runner enforces this via checksum drift detection.
 */
export const migrations: Migration[] = [m0001, m0002, m0003, m0004];

export type { Migration } from './types';

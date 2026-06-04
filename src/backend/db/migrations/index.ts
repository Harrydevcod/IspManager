import type { Migration } from './types';
import m0001 from './0001_initial_schema';
import m0002 from './0002_work_orders';
import m0003 from './0003_audit_logs';
import m0004 from './0004_payments_status_check';
import m0005 from './0005_expenses';
import m0006 from './0006_investments';
import m0007 from './0007_investment_profitability';
import m0008 from './0008_expense_allocation';
import m0009 from './0009_expense_categories';
import m0010 from './0010_expense_templates';
import m0011 from './0011_whatsapp_notices';
import m0012 from './0012_payments_allow_reissue';
import m0013 from './0013_client_duplicate_dismissals';
import m0014 from './0014_whatsapp_outbox';
import m0015 from './0015_whatsapp_notices_outbox_link';
import m0016 from './0016_sms_companion';
import m0017 from './0017_sms_outbox_failed_at';

/**
 * The migration chain, in the order new migrations are appended.
 * The runner sorts by `version` defensively, but keep this list ordered.
 *
 * To evolve the schema: add `NNNN_description.ts` exporting a `Migration` with
 * the next version number and append it here. Never edit a shipped migration —
 * the runner enforces this via checksum drift detection.
 */
export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017];

export type { Migration } from './types';

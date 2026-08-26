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
import m0018 from './0018_catalog_categories_materials';
import m0019 from './0019_audiovisual_addon';
import m0020 from './0020_document_sequences';
import m0022 from './0022_login_throttle';
import m0023 from './0023_job_runs';
import m0024 from './0024_dunning_funnel_notice_types';
import m0025 from './0025_catalog_backbone_flag';
import m0026 from './0026_catalog_backbone_qty';
import m0027 from './0027_investment_clients';
import m0028 from './0028_sms_outbox_created_status_index';
import m0029 from './0029_payment_lines_installation_kind';
import m0030 from './0030_service_device_shares';
import m0033 from './0033_physical_backbone_mapping';
import m0034 from './0034_retire_catalog_backbone_qty';
import m0035 from './0035_backbone_upstream';
import m0036 from './0036_backbone_multi_uplink';
import m0037 from './0037_network_probes';
import m0038 from './0038_service_events_status_changes';
import m0039 from './0039_pppoe_provisioning';
import m0040 from './0040_service_events_network';
import m0041 from './0041_plan_mbps_slash_units';
import m0042 from './0042_network_discovery';
import m0043 from './0043_equipment_rental';
import m0044 from './0044_return_condition';
import m0045 from './0045_service_events_transferencia';
import m0046 from './0046_catalog_repeater_type';
import m0047 from './0047_catalog_free_type';

/**
 * The migration chain, in the order new migrations are appended.
 * The runner sorts by `version` defensively, but keep this list ordered.
 *
 * To evolve the schema: add `NNNN_description.ts` exporting a `Migration` with
 * the next version number and append it here. Never edit a shipped migration —
 * the runner enforces this via checksum drift detection.
 */
// 0021 (money_centavos) ficou por usar — o runner ordena por versão e tolera o gap.
export const migrations: Migration[] = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0014, m0015, m0016, m0017, m0018, m0019, m0020, m0022, m0023, m0024, m0025, m0026, m0027, m0028, m0029, m0030, m0033, m0034, m0035, m0036, m0037, m0038, m0039, m0040, m0041, m0042, m0043, m0044, m0045, m0046, m0047];

export type { Migration } from './types';

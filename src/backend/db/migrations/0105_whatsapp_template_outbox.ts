import type { Migration } from './types';

const migration: Migration = {
  version: 105,
  name: 'whatsapp_template_outbox',
  sql: 'ALTER TABLE whatsapp_outbox ADD COLUMN template_json TEXT;'
};
export default migration;

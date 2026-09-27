import type { Migration } from './types';

const migration: Migration = {
  version: 68,
  name: 'backbone_router_interface',
  sql: `ALTER TABLE backbone_devices ADD COLUMN router_interface TEXT;`
};

export default migration;

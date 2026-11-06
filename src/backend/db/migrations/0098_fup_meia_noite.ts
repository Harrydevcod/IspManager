import type { Migration } from './types';

const migration: Migration = {
  version: 98,
  name: 'fup_meia_noite',
  sql: `
    INSERT INTO fup_settings_history (key, old_value, new_value, changed_by, reason)
    SELECT key, value, '00:00', 'sistema', 'Extensão da janela de pico até à meia-noite'
    FROM fup_settings
    WHERE key = 'janela_pico_fim' AND value = '23:00' AND updated_at IS NULL;

    UPDATE fup_settings SET value = '00:00'
    WHERE key = 'janela_pico_fim' AND value = '23:00' AND updated_at IS NULL;
  `
};

export default migration;

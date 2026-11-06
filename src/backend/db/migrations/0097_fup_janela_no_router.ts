import type { Migration } from './types';

/**
 * A janela de pico da FUP passa a viver numa fila simples com `time=` no router (ADR 0022):
 * o método PROFILE (trocar o perfil do secret) deixa de existir, e com ele a escolha.
 * O histórico da chave fica — nunca se apaga.
 */
const migration: Migration = {
  version: 97,
  name: 'fup_janela_no_router',
  sql: `
    DELETE FROM fup_settings WHERE key = 'fup_aplicacao_metodo';
  `
};

export default migration;

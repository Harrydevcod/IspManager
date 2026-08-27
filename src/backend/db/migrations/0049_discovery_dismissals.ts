import type { Migration } from './types';

/**
 * Propostas da descoberta que alguém já disse para deixar em paz.
 *
 * A descoberta compara o que está na rede com o que está no registo e propõe
 * as diferenças. Algumas dessas diferenças estão certas assim: um endereço que
 * é para ficar em branco, um equipamento que responde outro modelo por um
 * motivo conhecido. Sem forma de as dispensar, a lista mostra a mesma coisa a
 * cada varrimento e ensina quem a usa a ignorá-la — o mesmo problema que a
 * `0013_client_duplicate_dismissals` resolveu para os clientes duplicados.
 *
 * A chave é (que proposta, sobre que registo). Não inclui o valor proposto de
 * propósito: dispensar "o MAC deste equipamento" vale para o MAC que houver,
 * senão bastava o aparelho responder outra coisa para o aviso voltar.
 *
 * ponytail: sem `expires_at`. Se um dia for preciso rever dispensas antigas,
 * a coluna `dismissed_at` já lá está para isso.
 */
const migration: Migration = {
  version: 49,
  name: 'discovery_dismissals',
  sql: `
    CREATE TABLE IF NOT EXISTS network_discovery_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'mac_em_falta' | 'ip_em_falta' | 'ip_mudou' | 'modelo_diferente' | 'backbone_ausente'
      kind TEXT NOT NULL,
      -- Sobre que registo: 'backbone' | 'assignment'.
      target_kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      dismissed_by INTEGER REFERENCES users(id),
      dismissed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (kind, target_kind, target_id)
    );
  `
};

export default migration;

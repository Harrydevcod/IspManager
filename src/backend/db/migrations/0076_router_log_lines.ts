import type { Migration } from './types';

/**
 * As linhas do registo do router, tal como a vigia as lê.
 *
 * `router_log_findings` só guarda somas por dia: sabe-se que uma antena caiu sete vezes, não a
 * que horas, nem o que o router escreveu à volta. As linhas estão no cartão do router, mas só
 * se lhes chega na rede de gestão; aqui ficam à mão, por dia.
 *
 * `at` é a hora local do router ("AAAA-MM-DD hh:mm:ss"), como em `router_log_findings`. Não há
 * chave de unicidade — o router escreve linhas iguais no mesmo segundo; quem garante que cada
 * uma entra uma vez é o cursor da vigia.
 */
const migration: Migration = {
  version: 76,
  name: 'router_log_lines',
  sql: `
    CREATE TABLE router_log_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      topics TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE INDEX idx_router_log_lines_at ON router_log_lines(at);
  `
};

export default migration;

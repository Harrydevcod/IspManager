import type { Migration } from './types';

/**
 * Cada linha do registo do router entra uma vez, pelo conteúdo.
 *
 * Até aqui só o cursor da vigia impedia repetidos; reler o cartão (importação histórica,
 * uma rotação a meio de uma leitura) voltava a inserir. O router escreve linhas iguais no
 * mesmo segundo, por isso a chave não pode ser só (hora, tópicos, mensagem): `seq` é a ordem
 * da linha entre as iguais desse segundo (0, 1, 2…), contada sobre tudo o que se leu.
 * As linhas já guardadas recebem o `seq` pela ordem em que entraram.
 */
const migration: Migration = {
  version: 88,
  name: 'router_log_lines_unique',
  sql: `
    ALTER TABLE router_log_lines ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

    UPDATE router_log_lines SET seq = (
      SELECT COUNT(*) FROM router_log_lines AS earlier
      WHERE earlier.at = router_log_lines.at AND earlier.topics = router_log_lines.topics
        AND earlier.message = router_log_lines.message AND earlier.id < router_log_lines.id
    );

    CREATE UNIQUE INDEX idx_router_log_lines_content ON router_log_lines(at, topics, message, seq);
  `
};

export default migration;

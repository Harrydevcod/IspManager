import type { Migration } from './types';

/**
 * Observabilidade dos jobs in-process. Os jobs (faturação automática, anuidade
 * audiovisual, despesas recorrentes, avisos de atraso, outbox/poll de WhatsApp e
 * SMS) corriam em `setInterval`/no arranque e só deixavam rasto nos logs do
 * processo — invisíveis na app. Esta tabela regista cada execução (estado,
 * duração e um resumo JSON do resultado) para alimentar um painel de saúde nas
 * Configurações.
 *
 * Versão 23: as versões 20–22 ficam reservadas para branches em curso
 * (numeração de documentos, dinheiro em centavos, throttle de login) — o runner
 * tolera gaps e ordena por versão, mas evita-se a colisão de número.
 */
const migration: Migration = {
  version: 23,
  name: 'job_runs',
  sql: `
    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok','skipped','error')),
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER,
      summary_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, id);
  `
};

export default migration;

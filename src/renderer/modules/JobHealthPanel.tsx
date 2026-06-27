import { Activity, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Message } from '../components';
import { authFetch } from '../lib/auth';
import { formatPtDateTime } from '../lib/format';

type JobStatus = 'ok' | 'skipped' | 'error';

type JobHealthEntry = {
  job: string;
  status: JobStatus;
  ranAt: string;
  durationMs: number | null;
  runs: number;
  errors: number;
  summary: unknown;
};

const JOB_LABELS: Record<string, string> = {
  auto_billing: 'Faturação automática',
  audiovisual_annual: 'Anuidade audiovisual',
  recurring_expenses: 'Despesas recorrentes',
  overdue_notices: 'Avisos de atraso (WhatsApp)',
  whatsapp_drain: 'Envio WhatsApp (fila)',
  whatsapp_poll: 'Estado de entrega WhatsApp',
  sms_drain: 'Envio SMS (fila)',
  sms_poll: 'Estado de entrega SMS'
};

const statusTone: Record<JobStatus, 'success' | 'neutral' | 'danger'> = {
  ok: 'success',
  skipped: 'neutral',
  error: 'danger'
};

const statusLabel: Record<JobStatus, string> = {
  ok: 'OK',
  skipped: 'Ignorado',
  error: 'Erro'
};

/** Resumo compacto do último resultado, para a linha do job. */
function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return '';
  const entries = Object.entries(summary as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== 0)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return entries.join(' · ');
}

export function JobHealthPanel() {
  const [jobs, setJobs] = useState<JobHealthEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('http://127.0.0.1:3001/api/jobs/health');
      if (!res.ok) throw new Error();
      const data = await res.json() as { jobs: JobHealthEntry[] };
      setJobs(data.jobs);
    } catch {
      setError('Não foi possível carregar a saúde dos jobs.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <section className="job-health-panel">
      <header className="backups-head">
        <div>
          <h3>Saúde dos automatismos</h3>
          <p className="backups-dir">Tarefas em segundo plano: faturação, avisos e envios. Última execução de cada uma.</p>
        </div>
        <Button variant="secondary" size="sm" leadingIcon={<RefreshCw size={14} aria-hidden />} loading={loading} onClick={() => void load()}>
          Atualizar
        </Button>
      </header>

      {error && <Message tone="error">{error}</Message>}

      {!error && jobs.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Activity}
          title="Ainda sem execuções registadas"
          description="As tarefas correm no arranque e em intervalos. Aparecem aqui assim que correrem pela primeira vez."
        />
      ) : (
        <ul className="job-health-list">
          {jobs.map((entry) => {
            const summary = summaryText(entry.summary);
            return (
              <li key={entry.job} className="job-health-item">
                <div className="job-health-meta">
                  <strong>{JOB_LABELS[entry.job] || entry.job}</strong>
                  <small>
                    {formatPtDateTime(entry.ranAt)}
                    {entry.durationMs != null && ` · ${entry.durationMs} ms`}
                    {entry.errors > 0 && ` · ${entry.errors} erro(s) em ${entry.runs}`}
                  </small>
                  {summary && <small className="job-health-summary">{summary}</small>}
                </div>
                <Badge tone={statusTone[entry.status]}>{statusLabel[entry.status]}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

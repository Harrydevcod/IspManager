import { Fragment, useEffect, useMemo, useState } from 'react';
import { Gauge, History, RotateCcw } from 'lucide-react';
import { Button, DataTable, EmptyState, Field, Message, Select, Textarea, useConfirm, useToast } from '../../components';
import { useAuth } from '../../lib/auth';
import { formatPtDate, formatPtDateTime } from '../../lib/format';
import { fupRequest, type FupApiError, type FupHistoryRow, type FupSettingRow } from '../fup/fup-api';
import '../fup/fup.css';

type Impact = { aviso: number; limitados: number };
type Preview = { current: Impact; candidate: Impact };
type Pool = { enabled: boolean; cycle: { start: string; end: string }; usedBytes: number; packageGb: number; percent: number; activeClients: number; extraConnections: number; shareGb: number; exhausted: boolean };

// O pt-PT não agrupa 4 algarismos (7432); aqui agrupa sempre, como "9 000 GB".
const gbText = (value: number) => (value < 10 ? value.toFixed(1).replace('.', ',') : String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

const CHOICES: Record<string, Array<[string, string]>> = {
  canal_aviso: [['WHATSAPP', 'WhatsApp'], ['SMS', 'SMS']],
  acao_ao_limite: [['REDUZIR', 'Reduzir velocidade no pico'], ['BLOQUEAR', 'Bloquear ligação']],
  horario_limitacao: [['JANELA', 'Só no pico'], ['JANELA_FDS', 'Pico e fim de semana'], ['DIA_INTEIRO', 'Dia inteiro']],
  unidade_gb: [['DECIMAL', 'GB decimais'], ['BINARIO', 'GiB binários']],
  dia_ciclo: [['ATIVACAO', 'Dia da ativação'], ...Array.from({ length: 28 }, (_, i) => [String(i + 1), `Dia ${i + 1}`] as [string, string])]
};

/** Secções do painel: o que é de cada tipo de FUP e o que é comum aos dois. */
const SECTIONS: Array<[string, string[]]> = [
  ['FUP por plano', ['plafond_predefinido_gb', 'dia_ciclo']],
  ['FUP global', ['pacote_operadora_gb', 'ligacoes_extra_pacote', 'limiar_pacote_percent']],
  ['Limitação', ['acao_ao_limite', 'horario_limitacao', 'limiar_aviso_percent', 'limiar_limitacao_percent', 'percent_velocidade_pico', 'janela_pico_inicio', 'janela_pico_fim', 'fuso_horario']],
  ['Aviso e medição', ['canal_aviso', 'mensagem_aviso', 'unidade_gb', 'intervalo_recolha_minutos']]
];
const SECTIONED = new Set(SECTIONS.flatMap(([, keys]) => keys));

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

/** Como o valor aparece no histórico: escolhas com o nome legível, o resto como está. */
function displayValue(key: string, value: string | null): string {
  if (value === null) return '—';
  return CHOICES[key]?.find(([code]) => code === value)?.[1] ?? value;
}

/** Configurações › Uso justo. Toda a gente lê; só o administrador grava e repõe. */
export function FupSettingsPanel() {
  const auth = useAuth();
  const canWrite = auth.isAuthBypassed || auth.hasRole('admin');
  const confirm = useConfirm();
  const { toast } = useToast();
  const [settings, setSettings] = useState<FupSettingRow[] | null>(null);
  const [clockZone, setClockZone] = useState<string | null>(null);
  const [pool, setPool] = useState<Pool | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<FupHistoryRow[]>([]);
  const [historyFilter, setHistoryFilter] = useState({ key: '', from: '', to: '' });

  const labels = useMemo(() => new Map((settings ?? []).map((row) => [row.key, row.label])), [settings]);
  const changes = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of settings ?? []) {
      if (draft[row.key] !== undefined && draft[row.key] !== row.value) out[row.key] = draft[row.key];
    }
    return out;
  }, [draft, settings]);
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    fupRequest<{ settings: FupSettingRow[]; pool: Pool; routerClock: { clockZone: string | null } }>('/settings')
      .then((data) => { setSettings(data.settings); setPool(data.pool); setClockZone(data.routerClock.clockZone); })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(Object.entries(historyFilter).filter(([, value]) => value));
    fupRequest<{ history: FupHistoryRow[] }>(`/history${params.size ? `?${params}` : ''}`)
      .then((data) => setHistory(data.history))
      .catch(() => setHistory([]));
  }, [historyFilter, settings]);

  // Pré-visualização: o impacto da configuração em edição com os dados do ciclo corrente.
  useEffect(() => {
    if (!dirty) { setPreview(null); setErrors({}); return; }
    const timer = setTimeout(() => {
      fupRequest<Preview>('/preview', { method: 'POST', body: JSON.stringify({ changes }) })
        .then((data) => { setPreview(data); setErrors({}); })
        .catch((err: Error & { body?: FupApiError }) => { setPreview(null); setErrors(err.body?.errors ?? {}); });
    }, 300);
    return () => clearTimeout(timer);
  }, [changes, dirty]);

  async function save() {
    setSaving(true);
    try {
      const result = await fupRequest<{ changed: string[]; settings: FupSettingRow[] }>('/settings', {
        method: 'PUT', body: JSON.stringify({ changes, reason: reason.trim() || null })
      });
      setSettings(result.settings);
      fupRequest<{ pool: Pool }>('/settings').then((data) => setPool(data.pool)).catch(() => undefined);
      setDraft({});
      setReason('');
      toast(`Configuração guardada (${result.changed.length} alteração/ões). Entra em vigor na próxima execução do motor.`, 'success');
    } catch (err) {
      const body = (err as { body?: FupApiError }).body;
      setErrors(body?.errors ?? {});
      toast(body?.error ?? 'Não foi possível guardar.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function reset(row: FupSettingRow) {
    const ok = await confirm({
      title: `Repor "${row.label}"?`,
      message: `O valor passa de ${displayValue(row.key, row.value)} para o default, ${displayValue(row.key, row.default)}. Fica registado no histórico.`,
      confirmLabel: 'Repor default'
    });
    if (!ok) return;
    try {
      const result = await fupRequest<{ settings: FupSettingRow[] }>(`/settings/${row.key}/reset`, { method: 'POST' });
      setSettings(result.settings);
      setDraft((current) => { const next = { ...current }; delete next[row.key]; return next; });
      toast(`${row.label} reposto.`, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  if (loadError) return <Message tone="error">Não foi possível carregar a configuração do uso justo: {loadError}</Message>;
  if (!settings) return <Message>A carregar…</Message>;

  const field = (row: FupSettingRow) => {
    const value = draft[row.key] ?? row.value;
    const set = (next: string) => setDraft((current) => ({ ...current, [row.key]: next }));
    // A bloquear, a ligação fica cortada o dia todo: o horário não tem efeito.
    const current = (key: string) => draft[key] ?? settings.find((s) => s.key === key)?.value;
    const blocked = (row.key === 'horario_limitacao' && current('acao_ao_limite') === 'BLOQUEAR')
      || (row.key === 'limiar_pacote_percent' && Number(current('pacote_operadora_gb')) === 0);
    const common = { label: row.label, hint: row.description, error: errors[row.key], disabled: !canWrite || blocked };
    if (CHOICES[row.key]) {
      return (
        <Select {...common} value={value} onChange={(event) => set(event.target.value)}>
          {CHOICES[row.key].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </Select>
      );
    }
    if (row.key === 'mensagem_aviso') return <Textarea {...common} rows={3} value={value} onChange={(event) => set(event.target.value)} />;
    if (row.type === 'HORA') return <Field {...common} type="time" value={value} onChange={(event) => set(event.target.value)} />;
    if (row.type === 'FUSO') return <Field {...common} list="fup-time-zones" value={value} onChange={(event) => set(event.target.value)} />;
    return <Field {...common} type="number" step={1} value={value} onChange={(event) => set(event.target.value)} />;
  };

  return (
    <section className="job-health-panel">
      <header className="backups-head">
        <div>
          <h3><Gauge size={16} aria-hidden /> Uso justo</h3>
        </div>
      </header>

      {!canWrite && <Message tone="neutral">Só administradores alteram a política de uso justo.</Message>}
      {clockZone && clockZone !== settings.find((row) => row.key === 'fuso_horario')?.value && (
        <Message tone="warn">O fuso do router ({clockZone}) difere do configurado. Acerte o fuso no router para que a janela de pico seja aplicada à hora pretendida.</Message>
      )}

      <datalist id="fup-time-zones">{TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>

      {SECTIONS.map(([title, keys], index) => {
        // Uma chave nova fora do mapa cai na última secção: nunca desaparece do ecrã.
        const rows = settings.filter((row) => keys.includes(row.key) || (index === SECTIONS.length - 1 && !SECTIONED.has(row.key)));
        const global = title === 'FUP global';
        const draftNumber = (key: string) => Number(draft[key] ?? settings.find((row) => row.key === key)?.value ?? 0);
        const packageGb = draftNumber('pacote_operadora_gb');
        const extra = draftNumber('ligacoes_extra_pacote');
        const perGb = settings.find((row) => row.key === 'unidade_gb')?.value === 'BINARIO' ? 1024 ** 3 : 1e9;
        return (
          <div key={title} className="fup-section">
            <h4 className="fup-section-title">{title}</h4>
            {title === 'FUP por plano' && <p className="fup-lede">Os valores do serviço e do plano mandam sobre estes.</p>}
            {global && pool?.enabled && (
              <Message tone={pool.exhausted ? 'warn' : 'neutral'}>
                {gbText(pool.usedBytes / perGb)} de {gbText(pool.packageGb)} GB gastos ({Math.round(pool.percent)} %) · {pool.exhausted ? 'todos limitados' : 'ciclo'} até {formatPtDate(pool.cycle.end)}
              </Message>
            )}
            <div className="fup-settings-grid">
              {rows.map((row) => (
                <Fragment key={row.key}>
                  <div className={`fup-setting${row.key === 'mensagem_aviso' ? ' fup-setting-text' : ''}${changes[row.key] !== undefined ? ' fup-setting-dirty' : ''}`}>
                    {field(row)}
                    <div className="fup-setting-meta">
                      <span>Default: {row.key === 'mensagem_aviso' ? 'texto recomendado' : displayValue(row.key, row.default)}</span>
                      <span>· {row.updatedAt ? `Alterado a ${formatPtDate(row.updatedAt)}${row.updatedBy ? ` por ${row.updatedBy}` : ''}` : 'Nunca alterado'}</span>
                      {canWrite && row.value !== row.default && (
                        <Button variant="ghost" size="sm" leadingIcon={<RotateCcw size={12} aria-hidden />} onClick={() => void reset(row)}>
                          Repor default
                        </Button>
                      )}
                    </div>
                  </div>
                  {/* A quota acompanha o pacote em edição: o que cada cliente leva, antes de gravar. */}
                  {row.key === 'ligacoes_extra_pacote' && pool && (
                    <div className="fup-setting">
                      <Field label="Quota por cliente (GB)" readOnly disabled value={packageGb > 0 && pool.activeClients + extra > 0 ? gbText(packageGb / (pool.activeClients + extra)) : '—'} />
                      <div className="fup-setting-meta"><span>{pool.activeClients} clientes ativos + {extra}</span></div>
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        );
      })}

      {canWrite && dirty && (
        <div className="fup-preview" role="status" aria-live="polite">
          {preview ? (
            <>
              <div>
                <strong>{preview.candidate.aviso}</strong> <span>em aviso</span>
                <div className="fup-preview-delta">hoje {preview.current.aviso}</div>
              </div>
              <div>
                <strong>{preview.candidate.limitados}</strong> <span>limitados</span>
                <div className="fup-preview-delta">hoje {preview.current.limitados}</div>
              </div>
            </>
          ) : (
            <span>{Object.keys(errors).length ? 'Corrija os campos assinalados.' : 'A calcular o impacto…'}</span>
          )}
          <div className="fup-preview-actions">
            <Field label="Motivo (opcional)" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
            <Button variant="secondary" onClick={() => setDraft({})} disabled={saving}>Descartar</Button>
            <Button onClick={() => void save()} loading={saving} disabled={Object.keys(errors).length > 0}>Guardar</Button>
          </div>
        </div>
      )}

      <header className="backups-head">
        <div>
          <h3><History size={16} aria-hidden /> Histórico de alterações</h3>
          <p className="fup-lede">Cada alteração fica registada e não se apaga.</p>
        </div>
      </header>
      <div className="fup-history-filters">
        <Select label="Parâmetro" value={historyFilter.key} onChange={(event) => setHistoryFilter((f) => ({ ...f, key: event.target.value }))}>
          <option value="">Todos</option>
          {settings.map((row) => <option key={row.key} value={row.key}>{row.label}</option>)}
        </Select>
        <Field label="Desde" type="date" value={historyFilter.from} onChange={(event) => setHistoryFilter((f) => ({ ...f, from: event.target.value }))} />
        <Field label="Até" type="date" value={historyFilter.to} onChange={(event) => setHistoryFilter((f) => ({ ...f, to: event.target.value }))} />
      </div>
      <DataTable
        className="fup-history-table"
        rows={history}
        rowKey={(row) => row.id}
        gridTemplateColumns="minmax(130px, 0.8fr) minmax(150px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr) minmax(90px, 0.6fr) minmax(120px, 1fr)"
        columns={[
          { header: 'Data', sortValue: (row) => row.changedAt, defaultDirection: 'desc', cell: (row) => formatPtDateTime(row.changedAt) },
          { header: 'Parâmetro', sortValue: (row) => labels.get(row.key) ?? row.key, cell: (row) => <span>{labels.get(row.key) ?? row.key}</span> },
          // Uma linha por valor: um texto longo (a mensagem) corta com reticências e lê-se inteiro ao passar o rato.
          { header: 'Antes', sortValue: (row) => row.oldValue ?? '', cell: (row) => <span title={displayValue(row.key, row.oldValue)}>{displayValue(row.key, row.oldValue)}</span> },
          { header: 'Depois', sortValue: (row) => row.newValue, cell: (row) => <strong title={displayValue(row.key, row.newValue)}>{displayValue(row.key, row.newValue)}</strong> },
          { header: 'Por', sortValue: (row) => row.changedBy, cell: (row) => <span>{row.changedBy}</span> },
          { header: 'Motivo', sortValue: (row) => row.reason ?? '', cell: (row) => <span title={row.reason ?? undefined}>{row.reason ?? '—'}</span> }
        ]}
        empty={<EmptyState size="sm" icon={History} title="Sem alterações" />}
      />
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Badge, Button, Field, Message, useToast } from '../../components';
import { useAuth } from '../../lib/auth';
import { formatPtDate, formatPtDateTime } from '../../lib/format';
import {
  EVENT_LABEL, STATE_LABEL, formatGb, fupRequest, usageTone,
  type FupEvent, type FupThresholds, type FupUsage
} from './fup-api';
import './fup.css';

type Detail = { usage: FupUsage; thresholds: FupThresholds; events: FupEvent[] };

export function FupUsageBar({ percent, thresholds, label }: { percent: number; thresholds: FupThresholds; label: string }) {
  const tone = usageTone(percent, thresholds);
  const shown = Math.round(percent);
  return (
    <div
      className={`fup-bar fup-bar-${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(100, shown)}
      aria-valuenow={shown}
    >
      <span className="fup-bar-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
      <span className="fup-bar-mark" style={{ left: `${Math.min(thresholds.aviso, 100)}%` }} aria-hidden />
    </div>
  );
}

/**
 * Plafond próprio do serviço (pacote extra ou exceção). Vazio = herda do plano
 * ou do predefinido; 0 = isento. Só o administrador grava.
 */
function PlafondField({ usage, onSaved }: { usage: FupUsage; onSaved: (usage: FupUsage) => void }) {
  const auth = useAuth();
  const canWrite = auth.isAuthBypassed || auth.hasRole('admin');
  const { toast } = useToast();
  const saved = usage.serviceReferenceGb === null ? '' : String(usage.serviceReferenceGb);
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  const trimmed = value.trim();
  const valid = trimmed === '' || (/^\d+$/.test(trimmed) && Number(trimmed) <= 100_000);

  async function save() {
    setSaving(true);
    try {
      const result = await fupRequest<{ usage: FupUsage | null }>(`/services/${usage.serviceId}/plafond`, {
        method: 'PUT', body: JSON.stringify({ referenceGb: trimmed === '' ? null : Number(trimmed) })
      });
      if (result.usage) onSaved(result.usage);
      toast('Plafond guardado.', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fup-plafond">
      <Field
        label="Plafond do serviço (GB)"
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        placeholder={usage.inheritedReferenceGb > 0 ? `${usage.inheritedReferenceGb} · herdado` : 'Sem plafond · herdado'}
        error={valid ? undefined : 'Inteiro de 0 a 100 000, ou vazio para herdar.'}
        disabled={!canWrite || saving}
        onChange={(event) => setValue(event.target.value)}
      />
      {canWrite && trimmed !== saved && (
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={!valid}>Guardar</Button>
      )}
    </div>
  );
}

/** Consumo do ciclo, estado FUP e eventos, na ficha do serviço. */
export function FupUsageSection({ serviceId }: { serviceId: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    fupRequest<Detail>(`/services/${serviceId}`)
      .then((data) => { if (alive) setDetail(data); })
      .catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [serviceId]);

  if (error) {
    return (
      <section className="technical-section">
        <Message tone="error">Não foi possível ler o consumo: {error}</Message>
      </section>
    );
  }

  const usage = detail?.usage;
  const stateTone = usage?.limitedNow ? 'danger' : usage?.state === 'LIMITADO' ? 'warn' : usage?.state === 'AVISO' ? 'warn' : 'neutral';

  return (
    <section className="technical-section fup-section" aria-busy={!detail}>
      <header className="technical-section-head">
        <div>
          <p className="eyebrow"><Gauge size={12} /> Uso justo</p>
          <h3>
            {usage ? (
              <>
                <span className="fup-headline">{Math.round(usage.percent)}%</span>
                <Badge tone={stateTone}>{usage.limitedNow ? 'Limitado agora' : STATE_LABEL[usage.state]}</Badge>
              </>
            ) : 'A carregar...'}
          </h3>
        </div>
        {usage && (
          <p className="fup-cycle">Ciclo {formatPtDate(usage.cycleStart)} – {formatPtDate(usage.cycleEnd)}</p>
        )}
      </header>

      {usage && detail && (
        usage.referenceGb <= 0 ? (
          <Message tone="neutral">
            {usage.serviceReferenceGb === 0 ? 'Serviço isento de plafond.' : 'Sem plafond.'} Consumo do ciclo: {formatGb(usage.totalBytes)}.
          </Message>
        ) : (
          <>
            <FupUsageBar percent={usage.percent} thresholds={detail.thresholds} label="Consumo do ciclo" />
            <dl className="fup-figures">
              <div><dt>Total</dt><dd>{formatGb(usage.totalBytes)} <small>de {usage.referenceGb} GB</small></dd></div>
              <div><dt>Download</dt><dd>{formatGb(usage.downloadBytes)}</dd></div>
              <div><dt>Upload</dt><dd>{formatGb(usage.uploadBytes)}</dd></div>
              {detail.thresholds.acao === 'BLOQUEAR'
                ? <div><dt>Ao limite</dt><dd>Bloqueado</dd></div>
                : <div><dt>Velocidade no pico</dt><dd>{usage.peakPercent}% <small>quando limitado</small></dd></div>}
            </dl>
          </>
        )
      )}

      {usage && detail && (
        <PlafondField usage={usage} onSaved={(next) => setDetail((current) => (current ? { ...current, usage: next } : current))} />
      )}

      {detail && detail.events.length > 0 && (
        <ol className="fup-events">
          {detail.events.map((event) => (
            <li key={event.id}>
              <Badge tone={event.kind === 'RESTAURADO' ? 'success' : event.kind === 'LIMITADO' ? 'danger' : 'warn'}>{EVENT_LABEL[event.kind]}</Badge>
              <span>{formatPtDateTime(event.createdAt)}</span>
              {typeof event.detail?.percent === 'number' && typeof event.detail.gb === 'number' && (
                <small>{event.detail.percent}% · {formatGb(event.detail.gb * 1024 ** 3)}</small>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

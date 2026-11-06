import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Badge, Message } from '../../components';
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

/** Consumo do ciclo, estado FUP e eventos, na ficha do serviço. Só leitura. */
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
            O plano {usage.planName ?? ''} não tem consumo de referência: este serviço está fora da política de uso justo.
            Consumo do ciclo: {formatGb(usage.totalBytes)}.
          </Message>
        ) : (
          <>
            <FupUsageBar percent={usage.percent} thresholds={detail.thresholds} label="Consumo do ciclo" />
            <dl className="fup-figures">
              <div><dt>Total</dt><dd>{formatGb(usage.totalBytes)} <small>de {usage.referenceGb} GB</small></dd></div>
              <div><dt>Download</dt><dd>{formatGb(usage.downloadBytes)}</dd></div>
              <div><dt>Upload</dt><dd>{formatGb(usage.uploadBytes)}</dd></div>
              <div><dt>Velocidade no pico</dt><dd>{usage.peakPercent}% <small>quando limitado</small></dd></div>
            </dl>
          </>
        )
      )}

      {detail && detail.events.length > 0 && (
        <ol className="fup-events">
          {detail.events.map((event) => (
            <li key={event.id}>
              <Badge tone={event.kind === 'RESTAURADO' ? 'success' : event.kind === 'LIMITADO' ? 'danger' : 'warn'}>{EVENT_LABEL[event.kind]}</Badge>
              <span>{formatPtDateTime(event.createdAt)}</span>
              {typeof event.detail?.percent === 'number' && <small>{event.detail.percent}% · {String(event.detail.gb ?? '')} GB</small>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

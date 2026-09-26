import { Activity, ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../components';
import { formatBitrate, ROUTER_API, trafficRates, type Live, type RouterWan, type WanRate } from './router-api';
import { useLive } from './useLive';

/**
 * ponytail: 3 s porque o transporte abre um TLS novo por pedido e o hEX S é
 * fraco de CPU; com um agente keep-alive no transporte podia descer para 1 s.
 */
const WAN_POLL_MS = 3_000;
/** 40 pontos de 3 s = os últimos 2 minutos. */
const HISTORY = 40;

const peak = (points: WanRate[]) => Math.max(1, ...points.flatMap((point) => [point.downBps ?? 0, point.upBps ?? 0]));

/** `max` é partilhado pelas WAN: alturas iguais querem dizer tráfego igual. */
function Sparkline({ points, max }: { points: WanRate[]; max: number }) {
  // Encostado à direita: o ponto mais recente fica sempre na ponta, como um gráfico ao vivo.
  const offset = HISTORY - points.length;
  const line = (pick: (point: WanRate) => number | null) => points
    .map((point, index) => `${((index + offset) / (HISTORY - 1)) * 100},${32 - ((pick(point) ?? 0) / max) * 30}`)
    .join(' ');
  return (
    <svg className="router-wan-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden>
      <polyline className="is-down" points={line((point) => point.downBps)} />
      <polyline className="is-up" points={line((point) => point.upBps)} />
    </svg>
  );
}

const sum = (rates: WanRate[], pick: (rate: WanRate) => number | null) =>
  rates.some((rate) => pick(rate) !== null) ? rates.reduce((total, rate) => total + (pick(rate) ?? 0), 0) : null;

/** Download e upload de cada interface da lista WAN, ao vivo, só enquanto está à vista. */
export function WanTraffic() {
  const live = useLive<Live<RouterWan>>(`${ROUTER_API}/wan`, true, WAN_POLL_MS);
  const previous = useRef<RouterWan | null>(null);
  const [latest, setLatest] = useState<WanRate[]>([]);
  const [history, setHistory] = useState<Record<string, WanRate[]>>({});

  useEffect(() => {
    const data = live.data;
    if (!data?.available) return;
    const sample: RouterWan = { sampledAt: data.sampledAt, interfaces: data.interfaces };
    // Uma resposta atrasada (ou o efeito duplo do StrictMode) não pode andar para trás.
    if (previous.current && sample.sampledAt <= previous.current.sampledAt) return;
    const rates = trafficRates(previous.current, sample);
    previous.current = sample;
    setLatest(rates);
    setHistory((current) => Object.fromEntries(rates.map((rate) => [rate.name, [...(current[rate.name] ?? []), rate].slice(-HISTORY)])));
  }, [live.data]);

  const scale = peak(Object.values(history).flat());
  const totalDown = sum(latest, (rate) => rate.downBps);
  const totalUp = sum(latest, (rate) => rate.upBps);

  return (
    <section className="router-wan" aria-label="Tráfego das WAN">
      <div className="router-wan-header">
        <h3><Activity size={16} aria-hidden /> Tráfego das WAN</h3>
        <span className="router-muted">ao vivo · de {WAN_POLL_MS / 1000} em {WAN_POLL_MS / 1000} s</span>
      </div>

      {live.data && !live.data.available ? (
        <p className="router-muted">{live.data.reason}</p>
      ) : latest.length === 0 ? (
        <p className="router-muted">{live.error ?? 'A ler as interfaces WAN…'}</p>
      ) : (
        <>
          <div className="router-wan-grid">
            {latest.map((rate) => (
              <article key={rate.name} className="router-wan-card">
                <div className="router-wan-card-head">
                  <strong className="router-mono">{rate.name}</strong>
                  {rate.running ? <Badge tone="success">Ligada</Badge> : <Badge tone="danger">Sem ligação</Badge>}
                </div>
                <div className="router-wan-rates">
                  <div className="is-down">
                    <span><ArrowDown size={14} aria-hidden /> Download</span>
                    <strong className="router-number">{formatBitrate(rate.downBps)}</strong>
                  </div>
                  <div className="is-up">
                    <span><ArrowUp size={14} aria-hidden /> Upload</span>
                    <strong className="router-number">{formatBitrate(rate.upBps)}</strong>
                  </div>
                </div>
                <Sparkline points={history[rate.name] ?? []} max={scale} />
              </article>
            ))}
          </div>
          {latest.length > 1 && (
            <p className="router-wan-total">
              Total <ArrowDown size={13} aria-hidden /> <strong className="router-number">{formatBitrate(totalDown)}</strong>
              {' · '}
              <ArrowUp size={13} aria-hidden /> <strong className="router-number">{formatBitrate(totalUp)}</strong>
              {totalDown ? (
                <span className="router-muted">
                  {' · download repartido '}
                  {latest.map((rate) => `${Math.round(((rate.downBps ?? 0) / totalDown) * 100)}%`).join(' / ')}
                </span>
              ) : null}
            </p>
          )}
        </>
      )}
    </section>
  );
}

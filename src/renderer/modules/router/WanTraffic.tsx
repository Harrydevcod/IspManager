import { Activity, ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge } from '../../components';
import { formatBitrate, ROUTER_API, type Live, type RouterWan, type WanRate } from './router-api';
import { useLive } from './useLive';

/**
 * Com a ligação TLS reutilizada, 1 s acompanha as taxas que o router mede,
 * as mesmas do Winbox, sem abrir uma ligação nova em cada leitura no hEX S.
 */
const WAN_POLL_MS = 1_000;
/** 120 pontos de 1 s = os últimos 2 minutos. */
const HISTORY = 120;

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

/** Chave do histórico da soma; não colide com um nome de interface do RouterOS. */
const TOTAL_KEY = '\0total';

function totalOf(rates: WanRate[]): WanRate {
  return {
    name: TOTAL_KEY,
    running: rates.some((rate) => rate.running),
    downBps: sum(rates, (rate) => rate.downBps),
    upBps: sum(rates, (rate) => rate.upBps)
  };
}

function WanCard({ title, badge, rate, points, max, footer, total = false }: {
  title: string;
  badge: ReactNode;
  rate: WanRate;
  points: WanRate[];
  max: number;
  footer?: ReactNode;
  total?: boolean;
}) {
  return (
    <article className={total ? 'router-wan-card is-total' : 'router-wan-card'}>
      <div className="router-wan-card-head">
        <strong className={total ? undefined : 'router-mono'}>{title}</strong>
        {badge}
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
      <Sparkline points={points} max={max} />
      {footer}
    </article>
  );
}

/** Download e upload de cada interface da lista WAN, ao vivo, só enquanto está à vista. */
export function WanTraffic() {
  const live = useLive<Live<RouterWan>>(`${ROUTER_API}/wan`, true, WAN_POLL_MS);
  const previousSampledAt = useRef<number | null>(null);
  const [latest, setLatest] = useState<WanRate[]>([]);
  const [history, setHistory] = useState<Record<string, WanRate[]>>({});

  useEffect(() => {
    const data = live.data;
    if (!data?.available) return;
    // Uma resposta atrasada (ou o efeito duplo do StrictMode) não pode andar para trás.
    if (previousSampledAt.current !== null && data.sampledAt <= previousSampledAt.current) return;
    const rates = data.interfaces;
    previousSampledAt.current = data.sampledAt;
    setLatest(rates);
    setHistory((current) => Object.fromEntries([...rates, totalOf(rates)].map((rate) => [rate.name, [...(current[rate.name] ?? []), rate].slice(-HISTORY)])));
  }, [live.data]);

  // A soma entra na escala: os três cartões medem-se com a mesma régua.
  const scale = peak(Object.values(history).flat());
  const total = totalOf(latest);
  const totalDown = total.downBps;
  const linked = latest.filter((rate) => rate.running).length;

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
        <div className={latest.length > 1 ? 'router-wan-grid has-total' : 'router-wan-grid'}>
          {latest.map((rate) => (
            <WanCard
              key={rate.name}
              title={rate.name}
              badge={rate.running ? <Badge tone="success">Ligada</Badge> : <Badge tone="danger">Sem ligação</Badge>}
              rate={rate}
              points={history[rate.name] ?? []}
              max={scale}
            />
          ))}
          {latest.length > 1 && (
            <WanCard
              total
              title="Total"
              badge={<Badge tone={linked === latest.length ? 'accent' : 'warn'}>{linked} de {latest.length} ligadas</Badge>}
              rate={total}
              points={history[TOTAL_KEY] ?? []}
              max={scale}
              footer={totalDown ? (
                <p className="router-wan-split router-muted">
                  {latest.map((rate) => `${rate.name} ${Math.round(((rate.downBps ?? 0) / totalDown) * 100)}%`).join(' · ')}
                </p>
              ) : null}
            />
          )}
        </div>
      )}
    </section>
  );
}

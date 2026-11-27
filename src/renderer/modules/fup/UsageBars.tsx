import { useLayoutEffect, useRef, useState } from 'react';
import { formatGb, gbLabel } from './fup-api';

export type UsageBar = { key: string; label: string; title: string; downBytes: number; upBytes: number; current?: boolean };

const HEIGHT = 200;
const PAD = { top: 18, right: 8, bottom: 26, left: 48 };
const FALLBACK_WIDTH = 720;
const GAP = 2;

function topRounded(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, h, w / 2));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Escalões redondos em GB (1, 2 ou 5 × 10ⁿ), no máximo 4. */
function ticks(maxGb: number): number[] {
  if (maxGb <= 0) return [];
  const raw = maxGb / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return Array.from({ length: Math.floor(maxGb / step) }, (_, i) => (i + 1) * step);
}

/**
 * Barras por período (mais antigo à esquerda), descarga por baixo e envio por cima,
 * no traço do gráfico de receita do Painel. A linha do plafond só na vista por ciclo.
 */
export function UsageBars({ bars, perGb, plafondBytes }: { bars: UsageBar[]; perGb: number; plafondBytes?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxBytes = Math.max(...bars.map((b) => b.downBytes + b.upBytes), plafondBytes ?? 0, 1);
  const scale = ticks((maxBytes * 1.1) / perGb);
  const topGb = scale.length ? scale[scale.length - 1] : maxBytes / perGb;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (bytes: number) => PAD.top + plotH - (bytes / perGb / Math.max(topGb, maxBytes / perGb)) * plotH;
  const baseline = PAD.top + plotH;
  const slot = (width - PAD.left - PAD.right) / Math.max(bars.length, 1);
  const barW = Math.max(6, Math.min(36, slot * 0.56));
  // Com muitas barras estreitas os rótulos do eixo saltam um em cada N.
  const labelEvery = Math.max(1, Math.ceil(44 / slot));
  const hovered = hover === null ? null : bars[hover];
  const barX = (i: number) => PAD.left + i * slot + (slot - barW) / 2;

  return (
    <div className="sparkline usage-bars" ref={ref}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} style={{ height: HEIGHT }} role="img" aria-label="Consumo por período, descarga e envio">
        {scale.map((gb) => (
          <g key={gb}>
            <line className="bar-grid" x1={PAD.left} x2={width - PAD.right} y1={y(gb * perGb)} y2={y(gb * perGb)} />
            <text className="bar-tick" x={PAD.left - 8} y={y(gb * perGb) + 4} textAnchor="end">{gb.toLocaleString('pt-PT')}</text>
          </g>
        ))}
        <text className="bar-tick" x={PAD.left - 8} y={PAD.top - 6} textAnchor="end">{gbLabel(perGb)}</text>
        <line className="bar-baseline" x1={PAD.left} x2={width - PAD.right} y1={baseline} y2={baseline} />
        {plafondBytes ? (
          <g>
            <line className="bar-avg" x1={PAD.left} x2={width - PAD.right} y1={y(plafondBytes)} y2={y(plafondBytes)} />
            <text className="bar-axis bar-axis-meta" x={width - PAD.right} y={y(plafondBytes) - 5} textAnchor="end">Plafond</text>
          </g>
        ) : null}
        {bars.map((bar, i) => {
          const x = barX(i);
          const downY = y(bar.downBytes);
          const totalY = y(bar.downBytes + bar.upBytes);
          const upH = Math.max(0, downY - totalY - (bar.downBytes > 0 && bar.upBytes > 0 ? GAP : 0));
          return (
            <g
              key={bar.key}
              className={`bar${hover === i ? ' bar-hovered' : ''}${bar.current ? ' bar-current' : ''}`}
              tabIndex={0}
              aria-label={`${bar.title}: ${formatGb(bar.downBytes + bar.upBytes, perGb)}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <rect className="bar-hitbox" x={PAD.left + i * slot + 1} y={PAD.top - 10} width={Math.max(0, slot - 2)} height={HEIGHT - PAD.top} rx="6" />
              {bar.downBytes > 0 && <path className="bar-seg bar-seg-down" d={topRounded(x, downY, barW, baseline - downY, bar.upBytes > 0 ? 0 : 4)} />}
              {upH > 0 && <path className="bar-seg bar-seg-up" d={topRounded(x, totalY, barW, upH, 4)} />}
              {i % labelEvery === (bars.length - 1) % labelEvery && (
                <text className={`bar-axis${bar.current ? ' bar-axis-current' : ''}`} x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle">{bar.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          className={barX(hover) > width / 2 ? 'bar-tooltip bar-tooltip-left' : 'bar-tooltip'}
          // Colado à barra (não à fatia): com poucas barras a fatia é larga e o tooltip ficava longe.
          style={{ left: barX(hover) > width / 2 ? barX(hover) - 8 : barX(hover) + barW + 8, top: PAD.top }}
          role="tooltip"
        >
          <p className="bar-tooltip-month">{hovered.title}</p>
          <dl className="bar-tooltip-rows">
            <div><dt><span className="dot dot-down" /> Download</dt><dd>{formatGb(hovered.downBytes, perGb)}</dd></div>
            <div><dt><span className="dot dot-up" /> Upload</dt><dd>{formatGb(hovered.upBytes, perGb)}</dd></div>
            <div className="bar-tooltip-total"><dt>Total</dt><dd>{formatGb(hovered.downBytes + hovered.upBytes, perGb)}</dd></div>
          </dl>
        </div>
      )}
      <p className="sparkline-legend">
        <span className="legend-item legend-down">Download</span>
        <span className="legend-item legend-up">Upload</span>
      </p>
    </div>
  );
}

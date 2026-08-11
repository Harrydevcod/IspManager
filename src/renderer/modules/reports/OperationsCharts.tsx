import { useId, useMemo, useState } from 'react';

/**
 * Gráficos do painel de operação, em SVG puro.
 *
 * Sem biblioteca de gráficos: o repositório já desenha o gráfico de receita à
 * mão em `RevenueBars`, e uma dependência nova por causa de duas roscas seria
 * peso morto no instalador. As cores vêm de `var(--…)` para nascerem certas nos
 * dois temas — nada de hexadecimais fixos.
 *
 * Todos recebem `ariaLabel` e expõem os valores em texto na legenda: o gráfico
 * é reforço visual, não o único sítio onde o número existe.
 */

export type Slice = {
  label: string;
  value: number;
  /** Cor CSS já resolvida pelo chamador, ex.: 'var(--success)'. */
  color: string;
};

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, start: number, end: number): string {
  // Um setor de 360° não se desenha com um arco só: início e fim coincidem e o
  // path colapsa. Recuar um milésimo de grau fecha o anel sem buraco visível.
  const sweep = Math.min(end - start, 359.999);
  const [x1, y1] = polar(cx, cy, rOuter, start);
  const [x2, y2] = polar(cx, cy, rOuter, start + sweep);
  const [x3, y3] = polar(cx, cy, rInner, start + sweep);
  const [x4, y4] = polar(cx, cy, rInner, start);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z'
  ].join(' ');
}

/** Rosca com centro ocupado pelo total — a leitura mais pedida fica no meio. */
export function DonutChart({
  slices,
  centerValue,
  centerLabel,
  ariaLabel,
  formatValue
}: {
  slices: Slice[];
  centerValue: string;
  centerLabel: string;
  ariaLabel: string;
  formatValue: (value: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const visible = slices.filter((slice) => slice.value > 0);

  const arcs = useMemo(() => {
    let cursor = 0;
    return visible.map((slice) => {
      const sweep = (slice.value / total) * 360;
      const arc = { slice, start: cursor, end: cursor + sweep };
      cursor += sweep;
      return arc;
    });
  }, [visible, total]);

  if (total <= 0) {
    return <p className="ops-chart-empty">Sem dados para representar.</p>;
  }

  return (
    <div className="ops-chart ops-chart-donut">
      <svg viewBox="0 0 132 132" role="img" aria-label={ariaLabel} onMouseLeave={() => setHovered(null)}>
        {arcs.map((arc, index) => (
          <path
            key={arc.slice.label}
            d={arcPath(66, 66, hovered === index ? 60 : 56, 40, arc.start, arc.end)}
            fill={arc.slice.color}
            fillOpacity={hovered === null || hovered === index ? 1 : 0.45}
            stroke="var(--surface)"
            strokeWidth="2"
            onMouseEnter={() => setHovered(index)}
          >
            <title>{`${arc.slice.label}: ${formatValue(arc.slice.value)}`}</title>
          </path>
        ))}
        <text x="66" y="63" textAnchor="middle" className="ops-donut-value">
          {hovered === null ? centerValue : formatValue(arcs[hovered].slice.value)}
        </text>
        <text x="66" y="78" textAnchor="middle" className="ops-donut-label">
          {hovered === null ? centerLabel : arcs[hovered].slice.label}
        </text>
      </svg>
      <ul className="ops-chart-legend">
        {visible.map((slice, index) => (
          <li
            key={slice.label}
            className={hovered === index ? 'is-hovered' : ''}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="ops-legend-dot" style={{ background: slice.color }} aria-hidden />
            <span className="ops-legend-label">{slice.label}</span>
            <span className="ops-legend-value">{formatValue(slice.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type BarRow = {
  key: string | number;
  label: string;
  sublabel?: string;
  value: number;
  /** Texto à direita da barra (valor formatado, quota, etc.). */
  valueLabel: string;
  color: string;
  /** Realça a linha — usado para concentração acima do limiar. */
  highlight?: boolean;
};

/** Barras horizontais: o formato que lê melhor quando os rótulos são nomes. */
export function BarChart({ rows, ariaLabel }: { rows: BarRow[]; ariaLabel: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) {
    return <p className="ops-chart-empty">Sem dados para representar.</p>;
  }
  return (
    <ul className="ops-bars" aria-label={ariaLabel}>
      {rows.map((row) => (
        <li key={row.key} className={row.highlight ? 'is-highlight' : ''}>
          <span className="ops-bar-id">
            <strong>{row.label}</strong>
            {row.sublabel && <small>{row.sublabel}</small>}
          </span>
          <span className="ops-bar-track" aria-hidden>
            <i style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: row.color }} />
          </span>
          <span className="ops-bar-value">{row.valueLabel}</span>
        </li>
      ))}
    </ul>
  );
}

export type TrendPoint = {
  label: string;
  /** 0–1. `null` desenha uma falha na série em vez de um zero enganador. */
  value: number | null;
  caption: string;
};

/**
 * Série de taxa de cobrança: área + linha + pontos.
 *
 * A escala é sempre 0–100%, nunca ajustada aos dados. Uma escala elástica faria
 * uma queda de 100% para 95% parecer um penhasco — exatamente o erro que este
 * painel existe para evitar.
 */
export function TrendChart({
  points,
  ariaLabel,
  warnBelow = 0.8,
  criticalBelow = 0.6
}: {
  points: TrendPoint[];
  ariaLabel: string;
  warnBelow?: number;
  criticalBelow?: number;
}) {
  const gradientId = useId();
  const [hovered, setHovered] = useState<number | null>(null);
  const width = 520;
  const height = 168;
  // A margem direita comporta metade de um rótulo de eixo ("07-2026"): o
  // último ponto assenta na borda da área útil e o texto é centrado nele, por
  // isso sem esta folga a etiqueta saía cortada fora do viewBox.
  const pad = { top: 14, right: 34, bottom: 30, left: 40 };
  const usableW = width - pad.left - pad.right;
  const usableH = height - pad.top - pad.bottom;

  const plotted = points
    .map((point, index) => ({
      ...point,
      index,
      x: pad.left + (points.length === 1 ? usableW / 2 : (usableW / (points.length - 1)) * index),
      y: point.value === null ? null : pad.top + usableH - point.value * usableH
    }))
    .filter((point): point is typeof point & { y: number } => point.y !== null);

  if (plotted.length === 0) {
    return <p className="ops-chart-empty">Ainda sem ciclos faturados.</p>;
  }

  const line = plotted.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = `${line} L${plotted.at(-1)!.x.toFixed(1)},${pad.top + usableH} L${plotted[0].x.toFixed(1)},${pad.top + usableH} Z`;

  function toneFor(value: number): string {
    if (value < criticalBelow) return 'var(--danger)';
    if (value < warnBelow) return 'var(--warn)';
    return 'var(--success)';
  }

  return (
    <div className="ops-chart ops-chart-trend">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHovered(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.5, warnBelow, 1].map((ratio) => {
          const y = pad.top + usableH - ratio * usableH;
          const isThreshold = ratio === warnBelow;
          return (
            <g key={ratio}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke={isThreshold ? 'var(--warn)' : 'var(--border)'}
                strokeOpacity={isThreshold ? 0.5 : 1}
                strokeDasharray={isThreshold ? '3 3' : undefined}
              />
              <text x={pad.left - 8} y={y + 3.5} textAnchor="end" className="ops-trend-axis">
                {Math.round(ratio * 100)}%
              </text>
            </g>
          );
        })}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {plotted.map((point) => (
          <g key={point.label} onMouseEnter={() => setHovered(point.index)}>
            <rect
              x={point.x - usableW / (points.length * 2)}
              y={pad.top}
              width={usableW / points.length}
              height={usableH}
              fill="transparent"
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={hovered === point.index ? 6 : 4}
              fill={toneFor(point.value!)}
              stroke="var(--surface)"
              strokeWidth="2"
            >
              <title>{`${point.label}: ${Math.round(point.value! * 100)}% — ${point.caption}`}</title>
            </circle>
            <text x={point.x} y={height - 10} textAnchor="middle" className="ops-trend-axis">
              {point.label}
            </text>
          </g>
        ))}
      </svg>
      {hovered !== null && points[hovered] && (
        <p className="ops-trend-readout" role="status" aria-live="polite">
          <strong>{points[hovered].label}</strong>
          <span>{points[hovered].value === null ? '—' : `${Math.round(points[hovered].value! * 100)}%`}</span>
          <small>{points[hovered].caption}</small>
        </p>
      )}
    </div>
  );
}

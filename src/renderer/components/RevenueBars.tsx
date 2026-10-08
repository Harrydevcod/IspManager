import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { RevenuePoint } from '../types';
import { formatCompactEscudos } from '../../shared/money';

const monthLabelFormatter = new Intl.DateTimeFormat('pt-PT', { month: 'short' });
const longMonthFormatter = new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric' });

function formatMonthLabel(referenceMonth: string): string {
  const [year, month] = referenceMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return monthLabelFormatter.format(date).replace('.', '');
}

function formatLongMonth(referenceMonth: string): string {
  const [year, month] = referenceMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return longMonthFormatter.format(date);
}

/**
 * Compact money label for the chart axis/labels and tooltips. Delegates to the
 * shared cifrão-aware formatter (`1,5M$`, `12k$`, `500$`); kept under this name
 * so existing import sites (Dashboard, ProfitModule) stay unchanged.
 */
export function formatCompactCve(value: number): string {
  return formatCompactEscudos(value);
}

const HEIGHT = 220;
/** `left` é a calha dos escalões do eixo (cabe `000.000`). */
const PAD = { top: 22, right: 8, bottom: 28, left: 56 };
const MAX_TICKS = 5;
/** Largura assumida até o contentor ser medido (e nos testes, onde mede 0). */
const FALLBACK_WIDTH = 720;
/** Folga acima da barra mais alta: é onde ficam presas as marcas de custo que rebentam a escala. */
const HEADROOM = 1.12;
const SEGMENT_GAP = 2;
const MARK_OVERHANG = 5;

/** Rectângulo com os cantos arredondados só em cima: a base assenta na linha de zero. */
function topRounded(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, h, w / 2));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Escalão do eixo com ponto de milhar e sem cifrão: `20.000`. */
function formatTick(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+$)/g, '.');
}

/**
 * Escalões redondos (passo 1, 2 ou 5 × 10ⁿ), no máximo `MAX_TICKS`. O passo sai de `max`;
 * `limit` é o topo da escala, para um máximo de 79.500 ainda mostrar a linha dos 80.000.
 */
export function revenueTicks(max: number, limit = max): number[] {
  if (max <= 0) return [];
  const raw = max / MAX_TICKS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!);
  const ticks: number[] = [];
  for (let value = step; value <= limit; value += step) ticks.push(value);
  return ticks;
}

/**
 * Geometria do gráfico em píxeis reais. A escala é a da RECEITA (pago + pendente):
 * investimentos e despesas não a esticam, porque um mês de investimento grande
 * esmagava as doze barras. O custo que passa do topo fica preso lá (`over`).
 */
export function revenueLayout(points: RevenuePoint[], width: number) {
  const usableW = width - PAD.left - PAD.right;
  const usableH = HEIGHT - PAD.top - PAD.bottom;
  const baselineY = PAD.top + usableH;
  const maxRevenue = Math.max(0, ...points.map((p) => p.paidCve + p.pendingCve));
  const maxCost = Math.max(0, ...points.map((p) => Math.max(p.expenseCve, p.opexCve)));
  // Sem receita nenhuma, as marcas de custo ficam com a escala para não desaparecerem.
  const maxValue = Math.max(1, maxRevenue > 0 ? maxRevenue : maxCost) * HEADROOM;
  const slot = points.length > 0 ? usableW / points.length : 0;
  const barWidth = Math.min(56, Math.max(8, slot * 0.46));
  const toY = (value: number) => Math.max(PAD.top, baselineY - (value / maxValue) * usableH);

  const bars = points.map((point, idx) => {
    const cx = PAD.left + slot * idx + slot / 2;
    const paidH = (point.paidCve / maxValue) * usableH;
    const rawPendingH = (point.pendingCve / maxValue) * usableH;
    const gap = paidH > 0 && rawPendingH > SEGMENT_GAP * 2 ? SEGMENT_GAP : 0;
    const paidY = baselineY - paidH;
    const pendingY = paidY - rawPendingH;
    const mark = (value: number) => (value > 0 ? { y: toY(value), over: value > maxValue, value } : null);
    const expense = mark(point.expenseCve);
    const opex = mark(point.opexCve);
    const topY = rawPendingH > 0 ? pendingY : paidY;
    // O valor sobe para cima de uma marca que lhe passasse por cima (de baixo para cima).
    const valueY = [expense, opex]
      .flatMap((m) => (m && !m.over ? [m.y] : []))
      .sort((a, b) => b - a)
      .reduce((y, markY) => (markY <= y + 2 && markY > y - 14 ? markY - 7 : y), topY - 6);
    return {
      key: point.referenceMonth,
      referenceMonth: point.referenceMonth,
      slotX: PAD.left + slot * idx,
      cx,
      x: cx - barWidth / 2,
      paidY,
      paidH,
      pendingY,
      pendingH: rawPendingH - gap,
      topY,
      valueY,
      total: point.paidCve + point.pendingCve,
      expense,
      opex
    };
  });

  const paidValues = points.map((p) => p.paidCve).filter((v) => v > 0);
  const avgPaid = paidValues.length > 0 ? paidValues.reduce((a, b) => a + b, 0) / paidValues.length : 0;
  const yearBreaks: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].referenceMonth.slice(0, 4) !== points[i].referenceMonth.slice(0, 4)) yearBreaks.push(i);
  }
  const ticks = revenueTicks(maxRevenue > 0 ? maxRevenue : maxCost, maxValue).map((value) => ({ value, y: toY(value) }));
  return { width, bars, maxValue, slot, barWidth, baselineY, avgPaid, avgY: toY(avgPaid), yearBreaks, ticks };
}

/**
 * Source of truth: Dashboard revenue chart. Paid/pending revenue bars with a per-month
 * mark for investimentos (expense) and despesas (opex); the hover tooltip computes
 * Lucro = pago - investimentos - despesas. Shared by Dashboard and Rentabilidade so both
 * tell the same profitability story from one implementation.
 */
export function RevenueBars({
  points,
  ariaLabel = 'Receita dos ultimos 12 meses',
  onSelectMonth
}: {
  points: RevenuePoint[];
  ariaLabel?: string;
  onSelectMonth?: (referenceMonth: string) => void;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const containerRef = useRef<HTMLDivElement>(null);

  // Desenha-se à largura real: um viewBox fixo esticado deformava letras e cantos.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const apply = (measured: number) => { if (measured > 0) setWidth(Math.round(measured)); };
    apply(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => apply(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => revenueLayout(points, width), [points, width]);

  const todayKey = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  if (points.every((p) => p.paidCve === 0 && p.pendingCve === 0 && p.expenseCve === 0 && p.opexCve === 0)) {
    const year = points[0]?.referenceMonth.slice(0, 4) ?? new Date().getFullYear();
    return <div className="sparkline-empty">Sem registos de receita em {year}.</div>;
  }

  const { baselineY, slot, barWidth } = layout;
  const labelY = baselineY + 18;
  // Abaixo disto os valores de meses vizinhos tocam-se: mostra-se um sim, um não.
  const everyValueFits = slot >= 44;
  const hovered = hoveredIdx !== null ? layout.bars[hoveredIdx] : null;
  const hoveredPoint = hoveredIdx !== null ? points[hoveredIdx] : null;
  const prevPoint = hoveredIdx !== null && hoveredIdx > 0 ? points[hoveredIdx - 1] : null;
  const deltaPct = hoveredPoint && prevPoint && prevPoint.paidCve > 0
    ? ((hoveredPoint.paidCve - prevPoint.paidCve) / prevPoint.paidCve) * 100
    : null;
  // O tooltip fica ao lado da coluna, do lado que tem espaço, e nunca tapa a barra.
  const tooltipLeft = hovered !== null && hovered.cx > width / 2;
  const hasPending = points.some((p) => p.pendingCve > 0);
  const hasExpense = points.some((p) => p.expenseCve > 0);
  const hasOpex = points.some((p) => p.opexCve > 0);

  return (
    <div className="sparkline" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role={onSelectMonth ? 'group' : 'img'}
        aria-label={ariaLabel}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {hovered && (
          <rect
            className="bar-band"
            x={hovered.slotX + 2}
            y={PAD.top - 14}
            width={Math.max(0, slot - 4)}
            height={HEIGHT - PAD.top + 10}
            rx="6"
          />
        )}

        {layout.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="bar-grid" x1={PAD.left} x2={width - PAD.right} y1={tick.y} y2={tick.y} />
            <text className="bar-tick" x={PAD.left - 10} y={tick.y + 4} textAnchor="end">{formatTick(tick.value)}</text>
          </g>
        ))}

        <line className="bar-baseline" x1={PAD.left} x2={width - PAD.right} y1={baselineY} y2={baselineY} />

        {layout.yearBreaks.map((breakIdx) => {
          const x = PAD.left + slot * breakIdx;
          return <line key={`year-${breakIdx}`} className="bar-year-break" x1={x} x2={x} y1={PAD.top} y2={baselineY} />;
        })}

        {layout.avgPaid > 0 && (
          <line className="bar-avg" x1={PAD.left} x2={width - PAD.right} y1={layout.avgY} y2={layout.avgY} />
        )}

        {layout.bars.map((bar, idx) => {
          const isCurrent = bar.referenceMonth === todayKey;
          const isHovered = idx === hoveredIdx;
          const showValue = bar.total > 0 && (everyValueFits || idx % 2 === 0 || isCurrent || isHovered);
          // Um só rótulo por mês para o custo que rebenta a escala: o maior dos dois.
          const overflow = [bar.expense, bar.opex]
            .filter((m) => m?.over)
            .reduce((max, m) => Math.max(max, m!.value), 0);
          let groupClass = 'bar';
          if (isCurrent) groupClass += ' bar-current';
          if (isHovered) groupClass += ' bar-hovered';
          if (onSelectMonth) groupClass += ' bar-clickable';
          const interactive = onSelectMonth
            ? {
                role: 'button',
                tabIndex: 0,
                'aria-label': `Ver pagamentos de ${formatLongMonth(bar.referenceMonth)}`,
                onClick: () => onSelectMonth(bar.referenceMonth),
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelectMonth(bar.referenceMonth);
                }
              }
            : {};
          return (
            <g
              key={bar.key}
              className={groupClass}
              style={{ ['--i' as never]: idx } as CSSProperties}
              onMouseEnter={() => setHoveredIdx(idx)}
              onFocus={() => setHoveredIdx(idx)}
              onBlur={() => setHoveredIdx(null)}
              {...interactive}
            >
              <rect className="bar-hitbox" x={bar.slotX + 2} y={PAD.top - 14} width={Math.max(0, slot - 4)} height={HEIGHT - PAD.top + 10} rx="6" />
              {bar.pendingH > 0 && (
                <path className="bar-seg bar-seg-pending" d={topRounded(bar.x, bar.pendingY, barWidth, bar.pendingH, 4)} />
              )}
              {bar.paidH > 0 && (
                <path className="bar-seg bar-seg-paid" d={topRounded(bar.x, bar.paidY, barWidth, bar.paidH, bar.pendingH > 0 ? 0 : 4)} />
              )}
              {([['expense', bar.expense], ['opex', bar.opex]] as const).map(([kind, mark]) => mark && (
                <g key={kind} className={`bar-mark bar-mark-${kind}`}>
                  <line className="bar-mark-ring" x1={bar.x - MARK_OVERHANG} x2={bar.x + barWidth + MARK_OVERHANG} y1={mark.y} y2={mark.y} />
                  <line className="bar-mark-line" x1={bar.x - MARK_OVERHANG} x2={bar.x + barWidth + MARK_OVERHANG} y1={mark.y} y2={mark.y} />
                </g>
              ))}
              {overflow > 0 && (
                <text x={bar.cx} y={PAD.top - 6} textAnchor="middle" className="bar-value bar-value-over">
                  ↑ {formatCompactCve(overflow)}
                </text>
              )}
              {showValue && (overflow === 0 || bar.topY > PAD.top + 22) && (
                <text x={bar.cx} y={bar.valueY} textAnchor="middle" className="bar-value">
                  {formatCompactCve(bar.total)}
                </text>
              )}
              <text
                x={bar.cx}
                y={labelY}
                textAnchor="middle"
                className={
                  isCurrent
                    ? 'bar-axis bar-axis-current'
                    : bar.referenceMonth > todayKey
                      ? 'bar-axis bar-axis-future'
                      : 'bar-axis'
                }
              >
                {formatMonthLabel(bar.referenceMonth)}
              </text>
            </g>
          );
        })}

        {layout.avgPaid > 0 && (
          <text x={width - PAD.right} y={layout.avgY - 5} textAnchor="end" className="bar-axis bar-axis-meta">
            média {formatCompactCve(layout.avgPaid)}
          </text>
        )}
      </svg>

      <p className="sparkline-legend">
        <span className="legend-item legend-paid">Pago</span>
        {hasPending && <span className="legend-item legend-pending">Pendente</span>}
        {hasExpense && <span className="legend-item legend-expense">Investimentos</span>}
        {hasOpex && <span className="legend-item legend-opex">Despesas</span>}
      </p>

      {hovered && hoveredPoint && (
        <div
          className={tooltipLeft ? 'bar-tooltip bar-tooltip-left' : 'bar-tooltip'}
          style={{ left: tooltipLeft ? hovered.slotX - 4 : hovered.slotX + slot + 4, top: PAD.top }}
          role="status"
          aria-live="polite"
        >
          <p className="bar-tooltip-month">{formatLongMonth(hoveredPoint.referenceMonth)}</p>
          <dl className="bar-tooltip-rows">
            <div>
              <dt><span className="dot dot-paid" />Pago</dt>
              <dd>{formatCompactCve(hoveredPoint.paidCve)}</dd>
            </div>
            <div>
              <dt><span className="dot dot-pending" />Pendente</dt>
              <dd>{formatCompactCve(hoveredPoint.pendingCve)}</dd>
            </div>
            <div>
              <dt><span className="dot dot-expense" />Investimentos</dt>
              <dd>{formatCompactCve(hoveredPoint.expenseCve)}</dd>
            </div>
            <div>
              <dt><span className="dot dot-opex" />Despesas</dt>
              <dd>{formatCompactCve(hoveredPoint.opexCve)}</dd>
            </div>
            {(() => {
              const net = hoveredPoint.paidCve - hoveredPoint.expenseCve - hoveredPoint.opexCve;
              return (
                <div className={`bar-tooltip-total ${net < 0 ? 'profit-negative' : 'profit-positive'}`}>
                  <dt>Lucro</dt>
                  <dd>{formatCompactCve(net)}</dd>
                </div>
              );
            })()}
          </dl>
          {deltaPct !== null && (
            <p className={`bar-tooltip-delta ${deltaPct >= 0 ? 'positive' : 'negative'}`}>
              {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}% vs mes anterior
            </p>
          )}
        </div>
      )}
    </div>
  );
}

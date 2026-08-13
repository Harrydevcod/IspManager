import {
  Activity, AlertTriangle, CheckCircle2, Download, MessageSquareWarning,
  Network, PackageSearch, RefreshCw, ShieldAlert
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, EmptyState, ErrorRetry, SkeletonList } from '../../components';
import { formatCve, formatPtDateTime, formatPtMonth } from '../../lib/format';
import { formatCompactEscudos } from '../../../shared/money';
import { SEVERITY_LABELS, type OperationsSeverity, type OperationsStatus } from '../../../shared/operations-status';
import { downloadAuthenticated } from '../../lib/download';
import { BarChart, DonutChart, TrendChart, type BarRow, type Slice } from './OperationsCharts';
import { OPERATIONS_POLL_MS, useOperationsStatus } from './useOperationsStatus';
import './OperationsStatusPanel.css';

const SEVERITY_TONE: Record<OperationsSeverity, 'success' | 'warn' | 'danger'> = {
  green: 'success',
  amber: 'warn',
  red: 'danger'
};

const HORIZON_LABELS: Record<OperationsStatus['actions'][number]['horizon'], string> = {
  now: 'Agora',
  week: 'Esta semana',
  quarter: 'Próximos meses'
};

/** Paleta de séries. Percorrida por ordem para os gráficos categóricos. */
const SERIES = ['var(--accent)', 'var(--info)', 'var(--warn)', 'var(--success)', 'var(--accent-2)', 'var(--text-3)'];

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** Variação percentual entre dois períodos. `null` quando não há base de comparação. */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

type CardTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

/** Cartão de indicador com a barra de acento no topo, ao estilo do painel SKYNET. */
function StatCard({
  label, value, unit, note, tone = 'neutral', noteTone
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: CardTone;
  noteTone?: 'up' | 'down';
}) {
  return (
    <article className={`ops-stat is-${tone}`}>
      <span className="ops-stat-label">{label}</span>
      <strong className="ops-stat-value">
        {value}{unit && <small>{unit}</small>}
      </strong>
      {note && <span className={`ops-stat-note${noteTone ? ` is-${noteTone}` : ''}`}>{note}</span>}
    </article>
  );
}

function Panel({ title, meta, span, children }: { title: string; meta?: string; span?: boolean; children: ReactNode }) {
  return (
    <section className={`ops-card${span ? ' is-wide' : ''}`}>
      <header className="ops-card-head">
        <h3>{title}</h3>
        {meta && <span className="ops-card-meta">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="ops-rule">
      <span>{children}</span>
      {count !== undefined && <em>{count}</em>}
    </h2>
  );
}

function FindingList({ findings }: { findings: OperationsStatus['network']['findings'] }) {
  const relevant = findings.filter((finding) => finding.severity !== 'green');
  if (relevant.length === 0) return null;
  return (
    <ul className="ops-findings">
      {relevant.map((finding) => (
        <li key={finding.code} className={`ops-finding is-${finding.severity}`}>
          <AlertTriangle size={14} aria-hidden />
          <div>
            <strong>{finding.title}</strong>
            <small>{finding.detail}</small>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function OperationsStatusPanel({ active }: { active: boolean }) {
  const { status, error, loading, updatedAt, refresh } = useOperationsStatus(active);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportPdf() {
    setExporting(true);
    setExportError(null);
    try {
      await downloadAuthenticated(
        'http://127.0.0.1:3001/api/reports/operations.pdf',
        'Estado da operacao.pdf'
      );
    } catch {
      setExportError('Não foi possível gerar o PDF do estado da operação.');
    } finally {
      setExporting(false);
    }
  }

  // Erro sem dados anteriores é ecrã de falha; com dados anteriores é apenas um
  // aviso por cima do painel, que continua legível.
  if (error && !status) {
    return <ErrorRetry message={error} onRetry={refresh} />;
  }
  if (!status) {
    return <SkeletonList rows={6} />;
  }

  const { billing, customers, network, fleet, messaging, system, compliance, accessLayer } = status;
  const weekDelta = delta(billing.receivedThisWeekCve, billing.receivedPreviousWeekCve);

  const walletSlices: Slice[] = [
    { label: 'Pago', value: billing.wallet.paidCve, color: 'var(--success)' },
    { label: 'Vencido', value: billing.wallet.overdueCve, color: 'var(--danger)' },
    { label: 'Por vencer', value: billing.wallet.pendingNotDueCve, color: 'var(--warn)' },
    { label: 'Anulado', value: billing.wallet.cancelledCve, color: 'var(--text-3)' }
  ];

  // Só quem a sonda já leu: quem tem IP mas nunca foi sondado sai no rodapé.
  // Em baixo primeiro — é a linha que exige decisão agora.
  const probedDevices = network.devices
    .filter((device) => device.liveState !== null)
    .sort((a, b) => (a.liveState === b.liveState ? b.clientCount - a.clientCount : a.liveState === 'down' ? -1 : 1));

  const backboneRows: BarRow[] = network.devices.map((device) => ({
    key: device.backboneDeviceId,
    label: device.name,
    sublabel: device.upstreamNames.length > 0
      ? `via ${device.upstreamNames.join(', ')}${device.ipAddress ? ` · ${device.ipAddress}` : ''}`
      : `raiz — sem uplink alternativo${device.ipAddress ? ` · ${device.ipAddress}` : ''}`,
    value: device.mrrCve,
    valueLabel: `${device.clientCount} cl · ${formatCompactEscudos(device.mrrCve)} · ${pct(device.mrrShare)}`,
    color: device.mrrShare >= network.concentrationThreshold ? 'var(--warn)' : 'var(--accent)',
    highlight: device.mrrShare >= network.concentrationThreshold
  }));

  const deployedModels = fleet.models.filter((model) => model.deployed > 0);
  const fleetSlices: Slice[] = deployedModels.map((model, index) => ({
    label: model.label,
    value: model.deployed,
    color: SERIES[index % SERIES.length]
  }));

  const zoneRows: BarRow[] = customers.zones.slice(0, 6).map((zone) => ({
    key: zone.zone,
    label: zone.zone,
    value: zone.clients,
    valueLabel: `${zone.clients} · ${pct(zone.share)}`,
    color: zone.share >= network.concentrationThreshold ? 'var(--warn)' : 'var(--info)',
    highlight: zone.share >= network.concentrationThreshold
  }));

  const trendPoints = billing.collection.map((cycle) => ({
    label: formatPtMonth(cycle.referenceMonth),
    value: cycle.rate,
    caption: `${formatCve(cycle.collectedCve)} de ${formatCve(cycle.issuedCve)}`
  }));

  return (
    <div className="ops-panel">
      <header className={`ops-headline is-${status.severity}`}>
        <div className="ops-headline-main">
          <Badge tone={SEVERITY_TONE[status.severity]}>{SEVERITY_LABELS[status.severity]}</Badge>
          <p>{status.headline}</p>
        </div>
        <div className="ops-headline-actions">
          <small className="ops-freshness" aria-live="polite">
            {loading
              ? 'A atualizar…'
              : updatedAt
                ? `Atualizado às ${updatedAt.toLocaleTimeString('pt-PT')} · a cada ${OPERATIONS_POLL_MS / 1000}s`
                : ''}
          </small>
          <Button variant="ghost" size="sm" leadingIcon={<RefreshCw size={14} aria-hidden />} onClick={refresh}>
            Atualizar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Download size={14} aria-hidden />}
            loading={exporting}
            onClick={() => void exportPdf()}
          >
            PDF mensal
          </Button>
        </div>
      </header>

      {error && <p className="module-message error" role="status">{error} A mostrar a última leitura válida.</p>}
      {exportError && <p className="module-message error" role="alert">{exportError}</p>}

      <section className="ops-stats" aria-label="Indicadores da operação">
        <StatCard
          label="Clientes ativos"
          value={String(customers.active)}
          note={`${customers.activeServices} serviços · ARPU ${formatCompactEscudos(customers.arpuCve)}`}
          tone="accent"
        />
        <StatCard
          label="MRR contratado"
          value={formatCompactEscudos(customers.mrrCve)}
          note={customers.belowPlanPrice.services > 0
            ? `+${formatCompactEscudos(customers.belowPlanPrice.upliftCve)} se alinhar tarifas`
            : 'todas as tarifas alinhadas'}
          tone="accent"
        />
        <StatCard
          label="Recebido (7 dias)"
          value={formatCompactEscudos(billing.receivedThisWeekCve)}
          note={weekDelta === null
            ? `${billing.receivedThisWeekCount} pagamento(s)`
            : `${weekDelta >= 0 ? '▲ +' : '▼ '}${Math.round(weekDelta * 100)}% vs semana anterior`}
          noteTone={weekDelta === null ? undefined : weekDelta >= 0 ? 'up' : 'down'}
          tone={weekDelta !== null && weekDelta < 0 ? 'warn' : 'success'}
        />
        <StatCard
          label="Registado hoje"
          value={formatCompactEscudos(billing.registeredTodayCve)}
          note={`${billing.registeredTodayCount} pagamento(s)`}
          tone="neutral"
        />
        <StatCard
          label="Vencido"
          value={formatCompactEscudos(billing.wallet.overdueCve)}
          note={`${billing.wallet.overdueCount} título(s) · ${billing.debtors.length} devedor(es)`}
          tone={billing.wallet.overdueCve > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Por vencer"
          value={formatCompactEscudos(billing.wallet.pendingNotDueCve)}
          note={`${billing.wallet.pendingNotDueCount} título(s)`}
          tone="warn"
        />
        <StatCard
          label="Ordens abertas"
          value={String(customers.openWorkOrders)}
          note={`${customers.workOrdersCompleted} concluída(s) em 7 dias`}
          tone="neutral"
        />
        <StatCard
          label="Mensagens falhadas"
          value={String(messaging.whatsapp.failed)}
          note={messaging.whatsapp.providerBlocked ? 'canal recusado pelo provedor' : `${messaging.whatsapp.pending} em fila`}
          tone={messaging.whatsapp.providerBlocked ? 'danger' : messaging.whatsapp.failed > 0 ? 'warn' : 'neutral'}
        />
      </section>

      {status.actions.length > 0 && (
        <>
          <SectionTitle count={status.actions.length}>Próximas ações</SectionTitle>
          <div className="ops-actions">
            {(['now', 'week', 'quarter'] as const).map((horizon) => {
              const items = status.actions.filter((action) => action.horizon === horizon);
              if (items.length === 0) return null;
              return (
                <div key={horizon} className={`ops-action-group is-${horizon}`}>
                  <h4>{HORIZON_LABELS[horizon]}</h4>
                  {items.map((action) => (
                    <article key={action.code} className={`ops-action is-${action.severity}`}>
                      <span className="ops-action-code">{action.code}</span>
                      <div className="ops-action-body">
                        <strong>{action.title}</strong>
                        <small>{action.detail}</small>
                      </div>
                      {action.upsideCve !== null && (
                        <span className="ops-action-upside">{formatCve(action.upsideCve)}</span>
                      )}
                    </article>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      <SectionTitle>Cobrança</SectionTitle>
      <div className="ops-grid">
        <Panel title="Taxa de cobrança por ciclo" meta="escala fixa 0–100%" span>
          <TrendChart points={trendPoints} ariaLabel="Taxa de cobrança por ciclo de faturação" />
        </Panel>
        <Panel title="Carteira" meta={`${formatCve(billing.wallet.paidCve + billing.wallet.overdueCve + billing.wallet.pendingNotDueCve + billing.wallet.cancelledCve)} emitidos`}>
          <DonutChart
            slices={walletSlices}
            centerValue={formatCompactEscudos(billing.wallet.paidCve)}
            centerLabel="recebido"
            ariaLabel="Carteira por estado"
            formatValue={(value) => formatCve(value)}
          />
        </Panel>
      </div>

      <div className="ops-grid">
        <Panel title="Devedores" meta={`${billing.debtors.length} · ${formatCve(billing.wallet.overdueCve)}`} span>
          {billing.debtors.length === 0 ? (
            <EmptyState size="sm" icon={CheckCircle2} title="Nada vencido" description="Toda a carteira está dentro do prazo." />
          ) : (
            <ul className="ops-debtors">
              {billing.debtors.slice(0, 8).map((debtor) => (
                <li key={debtor.clientId} className={debtor.maxDaysOverdue >= 30 ? 'is-critical' : ''}>
                  <div>
                    <strong>
                      {debtor.clientName}
                      {debtor.clientCancelled && <Badge tone="danger">cancelado</Badge>}
                    </strong>
                    <small>{debtor.phone || 'sem telefone'}{debtor.zone ? ` · ${debtor.zone}` : ''}</small>
                  </div>
                  <span className="ops-debtor-amount">{formatCve(debtor.amountCve)}</span>
                  <span className="ops-debtor-days">{debtor.maxDaysOverdue} d</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Métodos de pagamento">
          <DonutChart
            slices={billing.methods.map((method, index) => ({
              label: method.method,
              value: method.amountCve,
              color: SERIES[index % SERIES.length]
            }))}
            centerValue={String(billing.methods.reduce((sum, method) => sum + method.count, 0))}
            centerLabel="recebimentos"
            ariaLabel="Distribuição por método de pagamento"
            formatValue={(value) => formatCve(value)}
          />
        </Panel>
      </div>
      <FindingList findings={billing.findings} />

      <SectionTitle count={network.devices.length}>Rede</SectionTitle>
      <div className="ops-grid">
        <Panel title="MRR por ponto de distribuição" meta={`concentração acima de ${pct(network.concentrationThreshold)}`} span>
          {network.devices.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Network}
              title="Sem backbone registado"
              description="Adiciona equipamentos na Topologia para veres aqui a carga e a receita por antena."
            />
          ) : (
            <BarChart rows={backboneRows} ariaLabel="Receita mensal por equipamento de backbone" />
          )}
        </Panel>
        <Panel title="Clientes por zona">
          <BarChart rows={zoneRows} ariaLabel="Clientes ativos por zona" />
        </Panel>
        <Panel
          title="Disponibilidade"
          meta={network.probe.lastRunAt ? `leitura de ${formatPtDateTime(network.probe.lastRunAt)}` : undefined}
          span
        >
          {probedDevices.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Activity}
              title={network.probe.enabled ? 'Sonda ligada, sem leituras' : 'Sonda desligada'}
              description={network.probe.enabled
                ? 'A primeira ronda de pings ainda não terminou, ou nenhum equipamento tem IP registado.'
                : 'Liga a sonda de rede em Definições para veres aqui que antenas estão de pé.'}
            />
          ) : (
            <ul className="ops-fleet">
              {probedDevices.map((device) => (
                <li key={device.backboneDeviceId} className={device.liveState === 'down' ? 'is-red' : device.uptime !== null && device.uptime < 0.99 ? 'is-amber' : ''}>
                  <strong>{device.name}</strong>
                  <small>{device.ipAddress}</small>
                  <span>{device.uptime === null ? '—' : pct(device.uptime)}</span>
                  <span className="ops-fleet-stock">{device.liveState === 'down' ? 'não responde' : 'de pé'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <FindingList findings={network.findings} />
      <p className="ops-note">
        Identificação: {network.identification.backboneWithIp}/{network.identification.backboneTotal} backbone com IP,
        {' '}{network.identification.assignmentWithMac}/{network.identification.assignmentTotal} equipamentos em campo com MAC.
        {network.probe.neverProbed > 0 && ` ${network.probe.neverProbed} com IP por sondar.`}
      </p>

      <SectionTitle>Parque e stock</SectionTitle>
      <div className="ops-grid">
        <Panel title="Stock de reserva" meta={`${fleet.deployedTotal} unidades em campo`} span>
          {fleet.models.filter((model) => model.deployed > 0 || model.stock > 0).length === 0 ? (
            <EmptyState size="sm" icon={PackageSearch} title="Catálogo vazio" description="Sem equipamentos registados no stock." />
          ) : (
            <ul className="ops-fleet">
              {fleet.models
                .filter((model) => model.deployed > 0 || model.stock > 0)
                .map((model) => (
                  <li key={model.catalogId} className={`is-${model.severity}`}>
                    <strong>{model.label}</strong>
                    <small>{model.type}</small>
                    <span>{model.deployed} em campo</span>
                    <span className="ops-fleet-stock">{model.stock} {model.unitOfMeasure} em stock</span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
        <Panel title="Parque instalado">
          <DonutChart
            slices={fleetSlices}
            centerValue={String(fleet.deployedTotal)}
            centerLabel="unidades"
            ariaLabel="Distribuição do parque instalado por modelo"
            formatValue={(value) => `${value} un`}
          />
        </Panel>
      </div>
      <FindingList findings={fleet.findings} />

      <SectionTitle>Canais, acesso e sistema</SectionTitle>
      <div className="ops-grid is-thirds">
        <Panel title="Mensagens">
          <p className="ops-note">
            WhatsApp: {messaging.whatsapp.sentThisWeek} enviadas esta semana ·
            {' '}{messaging.whatsapp.pending} em fila · {messaging.whatsapp.failed} falhadas.
          </p>
          <p className="ops-note">
            SMS de reserva: {messaging.sms.enabled ? (messaging.sms.paired ? 'ativo' : 'ativo mas sem emparelhamento') : 'desativado'}.
          </p>
          <MessageSquareWarning className="ops-card-glyph" size={18} aria-hidden />
        </Panel>
        <Panel title="Acesso">
          <p className="ops-note">
            {accessLayer.sharedUplinkServices} serviço(s) no mesmo uplink. PPPoE, QoS e histórico de sessões não são
            recolhidos — não há como medir débito por cliente nem cortar automaticamente por dívida.
          </p>
          <Network className="ops-card-glyph" size={18} aria-hidden />
        </Panel>
        <Panel title="Sistema">
          <p className="ops-note">
            Último backup: {system.lastBackupAt ? formatPtDateTime(system.lastBackupAt) : 'nenhum'}
            {system.backupAgeHours !== null && ` (há ${Math.round(system.backupAgeHours)} h)`}.
          </p>
          <p className="ops-note">
            Regime {compliance.fiscalRegime} · IVA {compliance.ivaRate}% ·
            {' '}{compliance.clientsWithNif}/{compliance.clientsTotal} clientes com NIF.
          </p>
          <ShieldAlert className="ops-card-glyph" size={18} aria-hidden />
        </Panel>
      </div>
      <FindingList findings={[...messaging.findings, ...accessLayer.findings, ...system.findings, ...compliance.findings]} />

      {status.risks.length > 0 && (
        <>
          <SectionTitle count={status.risks.length}>Riscos</SectionTitle>
          <ul className="ops-risks">
            {status.risks.map((risk) => (
              <li key={risk.code} className={`is-${risk.severity}`}>
                <span className="ops-risk-code">{risk.code}</span>
                <div>
                  <strong>{risk.title}</strong>
                  <small>{risk.detail}</small>
                </div>
                <span className="ops-risk-exposure">
                  {risk.exposureCve === null ? '—' : formatCve(risk.exposureCve)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="ops-footnote">
        Riscos e ações são derivados dos dados a cada leitura, não de uma lista fixa: resolvido o problema, a linha desaparece.
        Janela de comparação: {status.period.from} a {status.period.to}.
      </p>
    </div>
  );
}

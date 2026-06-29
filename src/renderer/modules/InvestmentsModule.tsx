import { Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Combobox, DataList, Dialog, EmptyState, ErrorRetry, Field, FilterBar, Message, MetricCard, MetricGrid, Select, Textarea, useConfirm, useToast } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve, formatPtDate, formatPtMonth } from '../lib/format';
import './InvestmentsModule.css';
import { EMPTY_INVESTMENT_LIST, type Client, type Investment, type InvestmentItemType, type InvestmentList, type InvestmentStatus, type InvestmentTimeline, type InvestmentType } from '../types';

const TYPES: { value: InvestmentType; label: string }[] = [
  { value: 'cliente', label: 'Cliente' },
  { value: 'zona', label: 'Zona' },
  { value: 'equipamento', label: 'Equipamento' },
  { value: 'infraestrutura', label: 'Infraestrutura' },
  { value: 'manutencao', label: 'Manutencao' },
  { value: 'expansao', label: 'Expansao' },
  { value: 'outro', label: 'Outro' }
];

const STATUSES: { value: InvestmentStatus; label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }[] = [
  { value: 'planeado', label: 'Planeado', tone: 'neutral' },
  { value: 'em_execucao', label: 'Em execucao', tone: 'info' },
  { value: 'ativo', label: 'Ativo', tone: 'success' },
  { value: 'recuperado', label: 'Recuperado', tone: 'success' },
  { value: 'cancelado', label: 'Cancelado', tone: 'danger' }
];

const ITEM_TYPES: { value: InvestmentItemType; label: string }[] = [
  { value: 'antena', label: 'Antena' },
  { value: 'router', label: 'Router' },
  { value: 'cpe', label: 'CPE' },
  { value: 'switch', label: 'Switch' },
  { value: 'cabo', label: 'Cabo' },
  { value: 'conector', label: 'Conector' },
  { value: 'fibra', label: 'Fibra' },
  { value: 'caixa', label: 'Caixa' },
  { value: 'poste', label: 'Poste' },
  { value: 'ups', label: 'UPS' },
  { value: 'bateria', label: 'Bateria' },
  { value: 'ferramenta', label: 'Ferramenta' },
  { value: 'material', label: 'Material' },
  { value: 'instalacao', label: 'Instalacao' },
  { value: 'mao_obra', label: 'Mao de obra' },
  { value: 'manutencao', label: 'Manutencao' },
  { value: 'outro', label: 'Outro' }
];

type ItemForm = {
  itemType: InvestmentItemType;
  itemName: string;
  quantity: string;
  quantityUsed: string;
  unitCostCve: string;
};

type FormState = {
  name: string;
  type: InvestmentType;
  clientId: string;
  zone: string;
  description: string;
  supplier: string;
  investmentDate: string;
  status: InvestmentStatus;
  targetClients: string;
  installedClients: string;
  desiredPaybackMonths: string;
  desiredMarginPct: string;
  expectedMonthlyRevenueCve: string;
  monthlyOperationalCostCve: string;
  accumulatedRevenueCve: string;
  notes: string;
  items: ItemForm[];
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return todayIso().slice(0, 7);
}

function blankItem(): ItemForm {
  return { itemType: 'cpe', itemName: '', quantity: '1', quantityUsed: '0', unitCostCve: '' };
}

function emptyForm(): FormState {
  return {
    name: '',
    type: 'cliente',
    clientId: '',
    zone: '',
    description: '',
    supplier: '',
    investmentDate: todayIso(),
    status: 'ativo',
    targetClients: '1',
    installedClients: '0',
    desiredPaybackMonths: '6',
    desiredMarginPct: '30',
    expectedMonthlyRevenueCve: '',
    monthlyOperationalCostCve: '',
    accumulatedRevenueCve: '',
    notes: '',
    items: [blankItem()]
  };
}

function fromInvestment(investment: Investment): FormState {
  return {
    name: investment.name,
    type: investment.type,
    clientId: investment.clientId ? String(investment.clientId) : '',
    zone: investment.zone || '',
    description: investment.description || '',
    supplier: investment.supplier || '',
    investmentDate: investment.investmentDate,
    status: investment.status,
    targetClients: String(investment.targetClients || 1),
    installedClients: String(investment.installedClients || 0),
    desiredPaybackMonths: String(investment.desiredPaybackMonths || 6),
    desiredMarginPct: String(investment.desiredMarginPct || 30),
    expectedMonthlyRevenueCve: String(investment.expectedMonthlyRevenueCve || ''),
    monthlyOperationalCostCve: String(investment.monthlyOperationalCostCve || ''),
    accumulatedRevenueCve: String(investment.accumulatedRevenueCve || ''),
    notes: investment.notes || '',
    items: investment.items.length
      ? investment.items.map((item) => ({
          itemType: item.itemType,
          itemName: item.itemName,
          quantity: String(item.quantity),
          quantityUsed: String(item.quantityUsed || 0),
          unitCostCve: String(item.unitCostCve)
        }))
      : [blankItem()]
  };
}

function parseMoney(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function itemTotal(item: ItemForm): number {
  const quantity = parseMoney(item.quantity);
  const unit = parseMoney(item.unitCostCve);
  if (!Number.isFinite(quantity) || !Number.isFinite(unit)) return 0;
  return quantity * unit;
}

function itemRemaining(item: ItemForm): number {
  const quantity = parseMoney(item.quantity);
  const used = parseMoney(item.quantityUsed);
  if (!Number.isFinite(quantity) || !Number.isFinite(used)) return 0;
  return Math.max(0, quantity - used);
}

function formatMonths(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Sem previsao';
  if (value < 1) return '< 1 mes';
  return `${value.toFixed(value >= 10 ? 0 : 1)} meses`;
}

export function InvestmentsModule() {
  const [data, setData] = useState<InvestmentList>(EMPTY_INVESTMENT_LIST);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [month, setMonth] = useState(currentMonth());
  const [type, setType] = useState<InvestmentType | 'all'>('all');
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<InvestmentTimeline | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Investment | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  const selected = data.rows.find((row) => row.id === selectedId) || data.rows[0] || null;
  const statusMeta = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s.value, s])), []);
  const typeLabel = useMemo(() => Object.fromEntries(TYPES.map((t) => [t.value, t.label])), []);
  const itemTypeLabel = useMemo(() => Object.fromEntries(ITEM_TYPES.map((t) => [t.value, t.label])), []);
  const formTotal = form.items.reduce((sum, item) => sum + itemTotal(item), 0);
  const formMonthlyRevenue = parseMoney(form.expectedMonthlyRevenueCve) || 0;
  const formMonthlyOps = parseMoney(form.monthlyOperationalCostCve) || 0;
  const formNetProfit = formMonthlyRevenue - formMonthlyOps;
  const formTargetClients = Math.max(1, Math.floor(parseMoney(form.targetClients) || 1));
  const formInstalledClients = Math.max(1, Math.floor(parseMoney(form.installedClients) || formTargetClients));
  const formPayback = Math.max(1, Math.floor(parseMoney(form.desiredPaybackMonths) || 6));
  const formMargin = Math.max(0, parseMoney(form.desiredMarginPct) || 0);
  const formAccumulatedRevenue = parseMoney(form.accumulatedRevenueCve) || 0;
  const formCostPerClient = formTotal / formTargetClients;
  const formRecommendedPlan = ((formCostPerClient / formPayback) + (formMonthlyOps / formInstalledClients)) * (1 + formMargin / 100);
  const formRecovery = formNetProfit > 0 ? formTotal / formNetProfit : null;
  const formRoi = formTotal > 0 ? ((formAccumulatedRevenue - formTotal) / formTotal) * 100 : null;

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (!showAllMonths) params.set('month', month);
    if (type !== 'all') params.set('type', type);
    return authFetch(`http://127.0.0.1:3001/api/investments?${params}`)
      .then((response) => response.json() as Promise<InvestmentList>)
      .then((payload) => {
        setData(payload);
        setLoadError(null);
        setSelectedId((current) => current && payload.rows.some((row) => row.id === current)
          ? current
          : payload.rows[0]?.id ?? null);
      })
      .catch(() => { setData(EMPTY_INVESTMENT_LIST); setLoadError('Não foi possível carregar os investimentos.'); });
  }, [month, type, showAllMonths]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/clients')
      .then((response) => response.ok ? response.json() as Promise<Client[]> : [])
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  useEffect(() => {
    if (!selected) {
      setTimeline(null);
      return;
    }
    let cancelled = false;
    authFetch(`http://127.0.0.1:3001/api/investments/${selected.id}/timeline`)
      .then((r) => r.ok ? r.json() as Promise<InvestmentTimeline> : null)
      .then((data) => { if (!cancelled) setTimeline(data); })
      .catch(() => { if (!cancelled) setTimeline(null); });
    return () => { cancelled = true; };
  }, [selected]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setError(null);
    setDialogOpen(true);
  }

  function openEdit(investment: Investment) {
    setEditing(investment);
    setForm(fromInvestment(investment));
    setError(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    if (submitting) return;
    setDialogOpen(false);
    setEditing(null);
    setError(null);
  }

  function updateItem(index: number, patch: Partial<ItemForm>) {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, i) => i === index ? { ...item, ...patch } : item)
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError('Nome do investimento obrigatorio.');
      return;
    }
    if (!form.items.every((item) => {
      const quantity = parseMoney(item.quantity);
      const used = parseMoney(item.quantityUsed);
      return item.itemName.trim() && quantity > 0 && used >= 0 && used <= quantity && parseMoney(item.unitCostCve) >= 0;
    })) {
      setError('Cada item deve ter nome, quantidade positiva, usado valido e custo unitario valido.');
      return;
    }

    setSubmitting(true);
    const url = editing
      ? `http://127.0.0.1:3001/api/investments/${editing.id}`
      : 'http://127.0.0.1:3001/api/investments';
    try {
      const response = await authFetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          clientId: form.clientId ? Number(form.clientId) : null,
          zone: form.zone.trim() || null,
          description: form.description.trim() || null,
          supplier: form.supplier.trim() || null,
          investmentDate: form.investmentDate,
          referenceMonth: form.investmentDate.slice(0, 7),
          status: form.status,
          targetClients: formTargetClients,
          installedClients: Math.max(0, Math.floor(parseMoney(form.installedClients) || 0)),
          desiredPaybackMonths: formPayback,
          desiredMarginPct: formMargin,
          expectedMonthlyRevenueCve: formMonthlyRevenue,
          monthlyOperationalCostCve: formMonthlyOps,
          accumulatedRevenueCve: formAccumulatedRevenue,
          notes: form.notes.trim() || null,
          items: form.items.map((item) => ({
            itemType: item.itemType,
            itemName: item.itemName.trim(),
            quantity: parseMoney(item.quantity),
            quantityUsed: parseMoney(item.quantityUsed),
            unitCostCve: parseMoney(item.unitCostCve)
          }))
        })
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(result.error || 'Falha ao guardar investimento.');
        return;
      }
      toast(editing ? 'Investimento atualizado.' : 'Investimento registado.', 'success');
      closeDialog();
      await load();
    } catch {
      setError('Falha de rede ao guardar investimento.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(investment: Investment) {
    if (!(await confirm({
      title: 'Apagar investimento',
      message: `Apagar o investimento "${investment.name}" (${formatCve(investment.totalCostCve)})?`,
      tone: 'danger',
      confirmLabel: 'Apagar'
    }))) return;
    const response = await authFetch(`http://127.0.0.1:3001/api/investments/${investment.id}`, { method: 'DELETE' });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string };
      toast(result.error || 'Falha ao apagar investimento.', 'error');
      return;
    }
    toast('Investimento apagado.', 'success');
    await load();
  }

  return (
    <section className="module-panel investments-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Painel financeiro ISP</p>
          <h2>Investimentos</h2>
        </div>
        <div className="inline-actions">
          <Field label="Mes" type="month" value={month} onChange={(e) => setMonth(e.target.value)} disabled={showAllMonths} />
          <Button size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={openCreate}>
            Novo investimento
          </Button>
        </div>
      </div>

      <MetricGrid label="Investimento próprio">
        <MetricCard
          icon={Wallet}
          label="Investido na infraestrutura própria"
          value={formatCve(data.totals.ownInfrastructureCve)}
          trend="sem stock"
          tone="info"
        />
      </MetricGrid>

      {data.equipmentTop.length > 0 && (
        <Card eyebrow="Top equipamentos" title="Por custo" className="investment-equipment-top">
          <ul>
            {data.equipmentTop.map((eq) => {
              const max = data.equipmentTop[0].totalCostCve || 1;
              const pct = (eq.totalCostCve / max) * 100;
              return (
                <li key={eq.itemType}>
                  <div className="row">
                    <span>{eq.itemType}</span>
                    <strong>{formatCve(eq.totalCostCve)}</strong>
                  </div>
                  <div className="bar"><div style={{ width: `${pct}%` }} /></div>
                  <small>{eq.quantityUsed} de {eq.quantity} usados</small>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {loadError && data.rows.length === 0 && <ErrorRetry message={loadError} onRetry={() => { void load(); }} />}

      <FilterBar>
        <Select label="Tipo" value={type} onChange={(e) => setType(e.target.value as InvestmentType | 'all')}>
          <option value="all">Todos</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => setShowAllMonths((s) => !s)} className={showAllMonths ? 'active' : ''}>
          {showAllMonths ? 'Mes selecionado' : 'Todos os meses'}
        </Button>
        <Button variant="secondary" onClick={() => { setType('all'); setMonth(currentMonth()); setShowAllMonths(false); }}>
          Limpar filtros
        </Button>
        <small>{showAllMonths ? 'Todos os meses' : formatPtMonth(month)}</small>
      </FilterBar>

      <div className="investments-layout">
        <DataList
          rows={data.rows}
          rowKey={(investment) => investment.id}
          activeKey={selected?.id}
          onRowClick={(investment) => setSelectedId(investment.id)}
          columns={[
            {
              cell: (investment) => (
                <span>
                  <strong>{investment.name}</strong>
                  <small>
                    {formatPtDate(investment.investmentDate)}
                    {investment.zone ? ` - ${investment.zone}` : ''}
                    {investment.clientName ? ` - ${investment.clientName}` : ''}
                  </small>
                </span>
              )
            },
            {
              cell: (investment) => (
                <Badge tone={statusMeta[investment.status]?.tone || 'neutral'}>
                  {statusMeta[investment.status]?.label || investment.status}
                </Badge>
              )
            },
            {
              cell: (investment) => <b>{formatCve(investment.totalCostCve)}</b>
            }
          ]}
          actions={(investment) => (
            <>
              <Button variant="icon" size="sm" title="Editar" onClick={() => openEdit(investment)}>
                <Pencil size={16} aria-hidden />
              </Button>
              <Button variant="icon" size="sm" title="Apagar" className="danger-ghost" onClick={() => void remove(investment)}>
                <Trash2 size={16} aria-hidden />
              </Button>
            </>
          )}
          empty={
            <EmptyState
              icon={Wallet}
              title="Sem investimentos neste filtro"
              description="Ajusta o intervalo de datas ou regista um novo investimento."
            />
          }
        />

        <aside className="investment-detail" aria-label="Detalhe do investimento">
          {selected ? (
            <>
              <div className="investment-detail-head">
                <span>{typeLabel[selected.type] || selected.type}</span>
                <h3>{selected.name}</h3>
                <p>{selected.description || selected.notes || 'Sem descricao adicional.'}</p>
              </div>
              <dl className="investment-detail-grid">
                <div>
                  <dt>Custo total</dt>
                  <dd>{formatCve(selected.totalCostCve)}</dd>
                </div>
                <div>
                  <dt>Retorno mensal</dt>
                  <dd>
                    {selected.actualMonthlyRevenueCve != null
                      ? formatCve(selected.actualMonthlyRevenueCve)
                      : formatCve(selected.expectedMonthlyRevenueCve)}
                    {selected.actualMonthlyRevenueCve != null && (
                      <small className="investment-detail-note">
                        {selected.revenueSource === 'global-share'
                          ? 'rateio'
                          : selected.revenueSource === 'zone'
                            ? 'real (zona)'
                            : 'real (cliente)'}; esperado {formatCve(selected.expectedMonthlyRevenueCve)}
                        {selected.revenueVarianceCve != null && (
                          <span className={`investment-variance ${selected.revenueVarianceCve >= 0 ? 'is-positive' : 'is-negative'}`}>
                            ({selected.revenueVarianceCve >= 0 ? '+' : ''}{formatCve(selected.revenueVarianceCve)})
                          </span>
                        )}
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Lucro mensal</dt>
                  <dd className={selected.monthlyNetProfitCve < 0 ? 'profit-negative' : 'profit-positive'}>
                    {formatCve(selected.monthlyNetProfitCve)}
                  </dd>
                </div>
                <div>
                  <dt>OPEX mensal</dt>
                  <dd>
                    {formatCve(selected.effectiveMonthlyOpexCve)}
                    <small className="investment-detail-note">
                      directo {formatCve(selected.monthlyOperationalCostCve)} + rateio {formatCve(selected.imputedMonthlyOpexCve)}
                      {selected.directAllocatedOpexCve > 0 && ` + alocado ${formatCve(selected.directAllocatedOpexCve)}`}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>Custo / cliente</dt>
                  <dd>{formatCve(selected.costPerClientCve)}</dd>
                </div>
                <div>
                  <dt>Plano recomendado</dt>
                  <dd>{formatCve(selected.recommendedPlanCve)}</dd>
                </div>
                <div>
                  <dt>Recuperacao</dt>
                  <dd>{formatMonths(selected.recoveryMonths)}</dd>
                </div>
                <div>
                  <dt>ROI atual</dt>
                  <dd>{selected.roiPct === null ? '-' : `${selected.roiPct.toFixed(1)}%`}</dd>
                </div>
              </dl>
              <div className="investment-items-preview">
                {selected.items.map((item) => (
                  <div key={item.id}>
                    <span>{itemTypeLabel[item.itemType] || item.itemType}</span>
                    <strong>{item.itemName}</strong>
                    <small>{item.quantity} comprado - {item.quantityUsed} usado - {item.quantityRemaining} restante</small>
                    <small>{item.quantity} x {formatCve(item.unitCostCve)} = {formatCve(item.totalCostCve)}</small>
                  </div>
                ))}
              </div>
              {timeline && timeline.points.length > 1 && (
                <div className="investment-timeline">
                    <div className="investment-timeline-head">
                      <strong>Evolução do lucro acumulado</strong>
                      <small>
                        {timeline.recoveredAt
                          ? `Recuperado em ${formatPtMonth(timeline.recoveredAt)} (${timeline.monthsToRecovery} meses)`
                          : 'Ainda não recuperado'}
                      </small>
                    </div>
                    {(() => {
                      const w = 320; const h = 70; const pad = 6;
                      const profits = timeline.points.map((p) => p.cumulativeProfitCve);
                      const min = Math.min(0, ...profits);
                      const max = Math.max(0, ...profits);
                      const range = max - min || 1;
                      const stepX = (w - pad * 2) / Math.max(1, timeline.points.length - 1);
                      const yFor = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / range);
                      const path = profits
                        .map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`)
                        .join(' ');
                      const zeroY = yFor(0);
                      const last = timeline.points[timeline.points.length - 1];
                      return (
                        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="investment-timeline-svg">
                          <line x1={pad} x2={w - pad} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeDasharray="2 3" />
                          <path d={path} fill="none" stroke={last.cumulativeProfitCve >= 0 ? 'var(--success)' : 'var(--danger)'} strokeWidth="1.5" />
                          <circle
                            cx={pad + (timeline.points.length - 1) * stepX}
                            cy={yFor(last.cumulativeProfitCve)}
                            r="2.5"
                            fill={last.cumulativeProfitCve >= 0 ? 'var(--success)' : 'var(--danger)'}
                          />
                        </svg>
                      );
                    })()}
                    <div className="investment-timeline-footer">
                      <span>
                        Hoje: <strong className={timeline.points[timeline.points.length - 1].cumulativeProfitCve < 0 ? 'profit-negative' : 'profit-positive'}>
                          {formatCve(timeline.points[timeline.points.length - 1].cumulativeProfitCve)}
                        </strong>
                      </span>
                      <span>{timeline.points.length} {timeline.points.length === 1 ? 'mês' : 'meses'}</span>
                    </div>
                  </div>
                )}

              {data.companyOpexShare.totalExpensesCve > 0 && (
                <div className="investment-opex-share">
                  <strong>Rateio OPEX da empresa</strong>
                  <span>OPEX médio: {formatCve(data.companyOpexShare.avgMonthlyOpex)} / mês ({data.companyOpexShare.monthsWithExpenses} {data.companyOpexShare.monthsWithExpenses === 1 ? 'mês' : 'meses'})</span>
                  <span>Por cliente instalado: {formatCve(data.companyOpexShare.opexPerClientPerMonth)} ({data.companyOpexShare.totalInstalledActive} instalados em investimentos ativos)</span>
                </div>
              )}
              {data.zoneSummary.length > 0 && (
                <div className="investment-zone-summary">
                  <strong>Zonas mais rentaveis</strong>
                  {data.zoneSummary.map((zone) => (
                    <span key={zone.zone}>
                      {zone.zone}: {formatCve(zone.monthlyNetProfitCve)} / mes
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <Message>Selecione um investimento para ver ROI, custos e materiais.</Message>
          )}
        </aside>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        eyebrow={editing ? 'Editar rentabilidade' : 'Novo investimento'}
        title={editing ? editing.name : 'Investimento e rentabilidade'}
        size="lg"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={submitting}>Cancelar</Button>
            <Button type="submit" form="investment-form" loading={submitting}>
              {submitting ? 'A guardar...' : editing ? 'Guardar alteracoes' : 'Registar'}
            </Button>
          </>
        }
      >
        <form id="investment-form" className="investment-form" onSubmit={submit}>
          {error && <Message tone="error">{error}</Message>}
          <div className="investment-form-grid">
            <div className="investment-form-section investment-form-section-main">
              <h3>Dados</h3>
              <Field wide label="Nome do investimento" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={180} />
              <Select label="Tipo" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as InvestmentType }))}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
              <Select label="Estado" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as InvestmentStatus }))}>
                {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </div>

            <div className="investment-form-section">
              <h3>Associacao</h3>
              <label>
                Cliente
                <Combobox
                  options={clients}
                  value={form.clientId ? Number(form.clientId) : null}
                  onChange={(next) => setForm((f) => ({ ...f, clientId: next == null ? '' : String(next) }))}
                  rowKey={(client) => client.id}
                  rowCode={(client) => client.clientCode}
                  rowLabel={(client) => client.fullName}
                  placeholder="Sem cliente"
                />
              </label>
              <Field label="Zona / bairro" value={form.zone} onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))} maxLength={120} />
              <Field label="Data" type="date" value={form.investmentDate} onChange={(e) => setForm((f) => ({ ...f, investmentDate: e.target.value }))} required />
              <Field label="Retorno mensal esperado" type="number" min={0} step={0.01} value={form.expectedMonthlyRevenueCve} onChange={(e) => setForm((f) => ({ ...f, expectedMonthlyRevenueCve: e.target.value }))} />
            </div>

            <div className="investment-form-section">
              <h3>Rentabilidade</h3>
              <Field label="Clientes previstos" type="number" min={1} step={1} value={form.targetClients} onChange={(e) => setForm((f) => ({ ...f, targetClients: e.target.value }))} />
              <Field label="Clientes instalados" type="number" min={0} step={1} value={form.installedClients} onChange={(e) => setForm((f) => ({ ...f, installedClients: e.target.value }))} />
              <Field label="Retorno desejado (meses)" type="number" min={1} step={1} value={form.desiredPaybackMonths} onChange={(e) => setForm((f) => ({ ...f, desiredPaybackMonths: e.target.value }))} />
              <Field label="Margem desejada (%)" type="number" min={0} step={0.01} value={form.desiredMarginPct} onChange={(e) => setForm((f) => ({ ...f, desiredMarginPct: e.target.value }))} />
              <Field label="Custo operacional mensal" type="number" min={0} step={0.01} value={form.monthlyOperationalCostCve} onChange={(e) => setForm((f) => ({ ...f, monthlyOperationalCostCve: e.target.value }))} />
              <Field label="Receita acumulada" type="number" min={0} step={0.01} value={form.accumulatedRevenueCve} onChange={(e) => setForm((f) => ({ ...f, accumulatedRevenueCve: e.target.value }))} />
            </div>

            <div className="investment-form-section investment-form-section-notes">
              <h3>Informacoes</h3>
              <Field label="Fornecedor" value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} maxLength={180} />
              <Textarea label="Descricao" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
            </div>
          </div>

          <div className="investment-items-editor">
            <div className="investment-items-editor-head">
              <strong>Custos do investimento</strong>
              <Button variant="secondary" size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem()] }))}>
                Adicionar item
              </Button>
            </div>
            <div className="investment-item-header" aria-hidden="true">
              <span>Tipo</span>
              <span>Equipamento / material</span>
              <span>Qtd.</span>
              <span>Usado</span>
              <span>Custo un.</span>
              <span>Total</span>
              <span />
            </div>
            {form.items.map((item, index) => (
              <div className="investment-item-row" key={index}>
                <Select value={item.itemType} onChange={(e) => updateItem(index, { itemType: e.target.value as InvestmentItemType })}>
                  {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
                <Field label="Equipamento / material" value={item.itemName} onChange={(e) => updateItem(index, { itemName: e.target.value })} placeholder="Equipamento/material" required />
                <Field label="Qtd." type="number" min={0.01} step={0.01} value={item.quantity} onChange={(e) => updateItem(index, { quantity: e.target.value })} required />
                <Field label="Usado" type="number" min={0} step={0.01} value={item.quantityUsed} onChange={(e) => updateItem(index, { quantityUsed: e.target.value })} required />
                <Field label="Custo un." type="number" min={0} step={0.01} value={item.unitCostCve} onChange={(e) => updateItem(index, { unitCostCve: e.target.value })} required />
                <strong title={`${itemRemaining(item)} restante`}>{formatCve(itemTotal(item))}</strong>
                <Button
                  variant="icon"
                  size="sm"
                  title="Remover item"
                  disabled={form.items.length === 1}
                  onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) }))}
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              </div>
            ))}
          </div>

          <div className="investment-form-summary">
            <span>Total: <strong>{formatCve(formTotal)}</strong></span>
            <span>Custo / cliente: <strong>{formatCve(formCostPerClient)}</strong></span>
            <span>Plano recomendado: <strong>{formatCve(formRecommendedPlan)}</strong></span>
            <span>Lucro mensal: <strong>{formatCve(formNetProfit)}</strong></span>
            <span>Recuperacao: <strong>{formatMonths(formRecovery)}</strong></span>
            <span>ROI atual: <strong>{formRoi === null ? '-' : `${formRoi.toFixed(1)}%`}</strong></span>
          </div>

          <Textarea className="investment-notes" label="Observacoes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
        </form>
      </Dialog>
    </section>
  );
}

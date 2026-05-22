import { Download, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, DataList, Dialog, FilterBar, Message, useToast } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve } from '../lib/format';
import type { Client, Investment, InvestmentItemType, InvestmentList, InvestmentStatus, InvestmentTimeline, InvestmentType } from '../types';

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
  const [data, setData] = useState<InvestmentList>({
    rows: [],
    totals: { count: 0, totalCostCve: 0, totalExpensesCve: 0, totalInvestedCve: 0, monthlyNetProfitCve: 0, accumulatedProfitCve: 0, totalImputedOpexCve: 0, totalDirectOpexCve: 0, totalEffectiveOpexCve: 0, totalActualRevenueCve: 0, averageRoiPct: null, lowRoiCount: 0, notRecoveredCount: 0 },
    companyOpexShare: { totalExpensesCve: 0, totalAllocatedCve: 0, totalUnallocatedCve: 0, monthsWithExpenses: 0, monthsWithUnallocated: 0, avgMonthlyOpex: 0, avgMonthlyUnallocated: 0, totalInstalledActive: 0, opexPerClientPerMonth: 0, directByInvestment: {}, directByZone: {}, directByClient: {} },
    zoneSummary: [],
    equipmentTop: [],
    alerts: []
  });
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
  const investmentReturnRows = useMemo(() => {
    const rows = data.rows
      .map((investment) => ({
        id: investment.id,
        name: investment.name,
        invested: investment.totalCostCve,
        annualReturn: investment.monthlyNetProfitCve * 12,
        roi: investment.annualRoiPct
      }))
      .sort((a, b) => Math.max(b.invested, b.annualReturn) - Math.max(a.invested, a.annualReturn))
      .slice(0, 8);
    const maxValue = Math.max(1, ...rows.flatMap((row) => [row.invested, Math.abs(row.annualReturn)]));
    return rows.map((row) => ({
      ...row,
      investedPct: (row.invested / maxValue) * 100,
      annualReturnPct: (Math.abs(row.annualReturn) / maxValue) * 100
    }));
  }, [data.rows]);

  function load() {
    const params = new URLSearchParams();
    if (!showAllMonths) params.set('month', month);
    if (type !== 'all') params.set('type', type);
    return authFetch(`http://127.0.0.1:3001/api/investments?${params}`)
      .then((response) => response.json() as Promise<InvestmentList>)
      .then((payload) => {
        setData(payload);
        setSelectedId((current) => current && payload.rows.some((row) => row.id === current)
          ? current
          : payload.rows[0]?.id ?? null);
      })
      .catch(() => setData({
        rows: [],
        totals: { count: 0, totalCostCve: 0, totalExpensesCve: 0, totalInvestedCve: 0, monthlyNetProfitCve: 0, accumulatedProfitCve: 0, totalImputedOpexCve: 0, totalDirectOpexCve: 0, totalEffectiveOpexCve: 0, totalActualRevenueCve: 0, averageRoiPct: null, lowRoiCount: 0, notRecoveredCount: 0 },
        companyOpexShare: { totalExpensesCve: 0, totalAllocatedCve: 0, totalUnallocatedCve: 0, monthsWithExpenses: 0, monthsWithUnallocated: 0, avgMonthlyOpex: 0, avgMonthlyUnallocated: 0, totalInstalledActive: 0, opexPerClientPerMonth: 0, directByInvestment: {}, directByZone: {}, directByClient: {} },
        zoneSummary: [],
        equipmentTop: [],
        alerts: []
      }));
  }

  useEffect(() => {
    void load();
  }, [month, type, showAllMonths]);

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
  }, [selected?.id]);

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
    if (!window.confirm(`Apagar investimento "${investment.name}" (${formatCve(investment.totalCostCve)})?`)) return;
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
          <h2>Investimentos e Rentabilidade ISP</h2>
        </div>
        <div className="inline-actions">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} disabled={showAllMonths} />
          <a
            href="http://127.0.0.1:3001/api/investments/report.pdf"
            target="_blank"
            rel="noreferrer"
            className="button-link"
            title="Exportar relatório PDF"
          >
            <FileText size={14} /> PDF
          </a>
          <a
            href="http://127.0.0.1:3001/api/investments/report.xlsx"
            className="button-link"
            title="Exportar dados em Excel"
          >
            <Download size={14} /> Excel
          </a>
          <button type="button" className="primary" onClick={openCreate}>
            <Plus size={14} /> Novo investimento
          </button>
        </div>
      </div>

      <div className="investment-metrics" aria-label="Indicadores de investimentos">
        <div>
          <span>Total investido</span>
          <strong>{formatCve(data.totals.totalInvestedCve)}</strong>
          <small>investimentos + despesas</small>
        </div>
        <div>
          <span>Lucro mensal liquido</span>
          <strong>{formatCve(data.totals.monthlyNetProfitCve)}</strong>
        </div>
        <div>
          <span>ROI medio</span>
          <strong>{data.totals.averageRoiPct === null ? '-' : `${data.totals.averageRoiPct.toFixed(1)}%`}</strong>
        </div>
        <div>
          <span>Lucro acumulado</span>
          <strong>{formatCve(data.totals.accumulatedProfitCve)}</strong>
        </div>
      </div>

      {data.alerts.length > 0 && (
        <div className="investment-alerts">
          {data.alerts.map((alert, idx) => (
            <span key={`${alert.severity}-${alert.message}-${idx}`} className={`alert-${alert.severity}`}>
              {alert.target && <strong>{alert.target.name}:</strong>} {alert.message}
            </span>
          ))}
        </div>
      )}

      {data.equipmentTop.length > 0 && (
        <section className="investment-equipment-top" aria-label="Top equipamentos">
          <header>
            <strong>Top equipamentos por custo</strong>
            <small>Soma dos investimentos no filtro atual</small>
          </header>
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
        </section>
      )}

      <section className="investment-return-panel" aria-label="Investimento versus retorno anual">
        <div className="investment-return-head">
          <div>
            <p className="eyebrow">Analise anual</p>
            <h3>Investimento x retorno anual</h3>
          </div>
          <span>Retorno anual = lucro mensal liquido x 12</span>
        </div>
        {investmentReturnRows.length > 0 ? (
          <div className="investment-return-chart">
            {investmentReturnRows.map((row) => (
              <div className="investment-return-row" key={row.id}>
                <div className="investment-return-name">
                  <strong>{row.name}</strong>
                  <small>{row.roi === null ? 'ROI sem dados' : `ROI anual ${row.roi.toFixed(1)}%`}</small>
                </div>
                <div className="investment-return-bars">
                  <div className="investment-return-barline">
                    <span>Investido</span>
                    <div><i className="bar-invested" style={{ width: `${row.investedPct}%` }} /></div>
                    <b>{formatCve(row.invested)}</b>
                  </div>
                  <div className="investment-return-barline">
                    <span>Retorno ano</span>
                    <div>
                      <i
                        className={row.annualReturn >= 0 ? 'bar-return-positive' : 'bar-return-negative'}
                        style={{ width: `${row.annualReturnPct}%` }}
                      />
                    </div>
                    <b>{formatCve(row.annualReturn)}</b>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="module-message">Registe investimentos para comparar capital aplicado e retorno anual.</p>
        )}
      </section>

      <FilterBar>
        <label>
          Tipo
          <select value={type} onChange={(e) => setType(e.target.value as InvestmentType | 'all')}>
            <option value="all">Todos</option>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setShowAllMonths((s) => !s)} className={showAllMonths ? 'active' : ''}>
          {showAllMonths ? 'Mes selecionado' : 'Todos os meses'}
        </button>
        <button type="button" onClick={() => { setType('all'); setMonth(currentMonth()); setShowAllMonths(false); }}>
          Limpar filtros
        </button>
        <small>{showAllMonths ? 'Todos os meses' : month}</small>
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
                    {investment.investmentDate}
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
              <button type="button" title="Editar" onClick={() => openEdit(investment)}>
                <Pencil size={16} />
              </button>
              <button type="button" title="Apagar" className="danger-ghost" onClick={() => void remove(investment)}>
                <Trash2 size={16} />
              </button>
            </>
          )}
          empty={<p className="module-message">Sem investimentos neste filtro.</p>}
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
                      <small style={{ display: 'block', color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
                        real ({selected.revenueSource === 'zone' ? 'zona' : 'cliente'}); esperado {formatCve(selected.expectedMonthlyRevenueCve)}
                        {selected.revenueVarianceCve != null && (
                          <span
                            style={{
                              marginLeft: 6,
                              color: selected.revenueVarianceCve >= 0 ? 'var(--success)' : 'var(--danger)',
                              fontVariantNumeric: 'tabular-nums'
                            }}
                          >
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
                    <small style={{ display: 'block', color: 'var(--text-3)', fontSize: 11, marginTop: 2 }}>
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
                          ? `Recuperado em ${timeline.recoveredAt} (${timeline.monthsToRecovery} meses)`
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
                  <span>Por cliente activo: {formatCve(data.companyOpexShare.opexPerClientPerMonth)} ({data.companyOpexShare.totalInstalledActive} clientes)</span>
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
            <p className="module-message">Selecione um investimento para ver ROI, custos e materiais.</p>
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
            <button type="button" onClick={closeDialog} disabled={submitting}>Cancelar</button>
            <button type="submit" form="investment-form" className="primary" disabled={submitting}>
              {submitting ? 'A guardar...' : editing ? 'Guardar alteracoes' : 'Registar'}
            </button>
          </>
        }
      >
        <form id="investment-form" className="investment-form" onSubmit={submit}>
          {error && <Message tone="error">{error}</Message>}
          <div className="investment-form-grid">
            <div className="investment-form-section investment-form-section-main">
              <h3>Dados</h3>
              <label className="field-wide">
                Nome do investimento
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required maxLength={180} />
              </label>
              <label>
                Tipo
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as InvestmentType }))}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label>
                Estado
                <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as InvestmentStatus }))}>
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
            </div>

            <div className="investment-form-section">
              <h3>Associacao</h3>
              <label>
                Cliente
                <select value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}>
                  <option value="">Sem cliente</option>
                  {clients.map((client) => <option key={client.id} value={client.id}>{client.fullName}</option>)}
                </select>
              </label>
              <label>
                Zona / bairro
                <input value={form.zone} onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))} maxLength={120} />
              </label>
              <label>
                Data
                <input type="date" value={form.investmentDate} onChange={(e) => setForm((f) => ({ ...f, investmentDate: e.target.value }))} required />
              </label>
              <label>
                Retorno mensal esperado
                <input type="number" min="0" step="0.01" value={form.expectedMonthlyRevenueCve} onChange={(e) => setForm((f) => ({ ...f, expectedMonthlyRevenueCve: e.target.value }))} />
              </label>
            </div>

            <div className="investment-form-section">
              <h3>Rentabilidade</h3>
              <label>
                Clientes previstos
                <input type="number" min="1" step="1" value={form.targetClients} onChange={(e) => setForm((f) => ({ ...f, targetClients: e.target.value }))} />
              </label>
              <label>
                Clientes instalados
                <input type="number" min="0" step="1" value={form.installedClients} onChange={(e) => setForm((f) => ({ ...f, installedClients: e.target.value }))} />
              </label>
              <label>
                Retorno desejado (meses)
                <input type="number" min="1" step="1" value={form.desiredPaybackMonths} onChange={(e) => setForm((f) => ({ ...f, desiredPaybackMonths: e.target.value }))} />
              </label>
              <label>
                Margem desejada (%)
                <input type="number" min="0" step="0.01" value={form.desiredMarginPct} onChange={(e) => setForm((f) => ({ ...f, desiredMarginPct: e.target.value }))} />
              </label>
              <label>
                Custo operacional mensal
                <input type="number" min="0" step="0.01" value={form.monthlyOperationalCostCve} onChange={(e) => setForm((f) => ({ ...f, monthlyOperationalCostCve: e.target.value }))} />
              </label>
              <label>
                Receita acumulada
                <input type="number" min="0" step="0.01" value={form.accumulatedRevenueCve} onChange={(e) => setForm((f) => ({ ...f, accumulatedRevenueCve: e.target.value }))} />
              </label>
            </div>

            <div className="investment-form-section investment-form-section-notes">
              <h3>Informacoes</h3>
              <label>
                Fornecedor
                <input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} maxLength={180} />
              </label>
              <label>
                Descricao
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
              </label>
            </div>
          </div>

          <div className="investment-items-editor">
            <div className="investment-items-editor-head">
              <strong>Custos do investimento</strong>
              <button type="button" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem()] }))}>
                <Plus size={14} /> Adicionar item
              </button>
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
                <select value={item.itemType} onChange={(e) => updateItem(index, { itemType: e.target.value as InvestmentItemType })}>
                  {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input value={item.itemName} onChange={(e) => updateItem(index, { itemName: e.target.value })} placeholder="Equipamento/material" required />
                <input type="number" min="0.01" step="0.01" value={item.quantity} onChange={(e) => updateItem(index, { quantity: e.target.value })} aria-label="Quantidade" required />
                <input type="number" min="0" step="0.01" value={item.quantityUsed} onChange={(e) => updateItem(index, { quantityUsed: e.target.value })} aria-label="Quantidade usada" required />
                <input type="number" min="0" step="0.01" value={item.unitCostCve} onChange={(e) => updateItem(index, { unitCostCve: e.target.value })} aria-label="Custo unitario" required />
                <strong title={`${itemRemaining(item)} restante`}>{formatCve(itemTotal(item))}</strong>
                <button
                  type="button"
                  title="Remover item"
                  disabled={form.items.length === 1}
                  onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) }))}
                >
                  <Trash2 size={14} />
                </button>
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

          <label className="investment-notes">
            Observacoes
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
          </label>
        </form>
      </Dialog>
    </section>
  );
}

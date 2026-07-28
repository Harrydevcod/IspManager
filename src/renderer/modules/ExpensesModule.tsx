import { FileText, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Combobox, DataTable, Dialog, EmptyState, ErrorRetry, Field, FilterBar, ModuleHeaderActions, Select, SkeletonList, Textarea, Toggle, useConfirm, useToast } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve, formatPtDate, formatPtMonth } from '../lib/format';
import './ExpensesModule.css';
import type { Client, Expense, ExpenseCategory, ExpenseList, ExpenseTemplate, ExpenseTemplateList, Investment, InvestmentList } from '../types';

type AllocationTarget = 'none' | 'investment' | 'zone' | 'client';

const CATEGORIES: { value: ExpenseCategory; label: string; tone: 'success' | 'danger' | 'info' | 'neutral' | 'accent' }[] = [
  { value: 'salarios', label: 'Salarios', tone: 'accent' },
  { value: 'banda_internet', label: 'Banda internet', tone: 'info' },
  { value: 'aluguer', label: 'Aluguer', tone: 'info' },
  { value: 'energia', label: 'Energia', tone: 'accent' },
  { value: 'infraestrutura', label: 'Infraestrutura', tone: 'info' },
  { value: 'equipamento', label: 'Equipamento', tone: 'neutral' },
  { value: 'manutencao', label: 'Manutencao', tone: 'neutral' },
  { value: 'reparacoes', label: 'Reparacoes', tone: 'danger' },
  { value: 'marketing', label: 'Marketing', tone: 'success' },
  { value: 'impostos', label: 'Impostos', tone: 'danger' },
  { value: 'licencas', label: 'Licencas', tone: 'neutral' },
  { value: 'combustivel', label: 'Combustivel', tone: 'neutral' },
  { value: 'deslocacoes', label: 'Deslocacoes', tone: 'neutral' },
  { value: 'outros', label: 'Outros', tone: 'neutral' }
];

type FormState = {
  category: ExpenseCategory;
  description: string;
  amountCve: string;
  expenseDate: string;
  supplier: string;
  invoiceReference: string;
  notes: string;
  allocationTarget: AllocationTarget;
  investmentId: string;
  zone: string;
  clientId: string;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return todayIso().slice(0, 7);
}

function emptyForm(): FormState {
  return {
    category: 'outros',
    description: '',
    amountCve: '',
    expenseDate: todayIso(),
    supplier: '',
    invoiceReference: '',
    notes: '',
    allocationTarget: 'none',
    investmentId: '',
    zone: '',
    clientId: ''
  };
}

function fromExpense(expense: Expense): FormState {
  const allocationTarget: AllocationTarget =
    expense.investmentId != null ? 'investment'
    : expense.clientId != null ? 'client'
    : expense.zone ? 'zone'
    : 'none';
  return {
    category: expense.category,
    description: expense.description,
    amountCve: String(expense.amountCve),
    expenseDate: expense.expenseDate,
    supplier: expense.supplier || '',
    invoiceReference: expense.invoiceReference || '',
    notes: expense.notes || '',
    allocationTarget,
    investmentId: expense.investmentId != null ? String(expense.investmentId) : '',
    zone: expense.zone || '',
    clientId: expense.clientId != null ? String(expense.clientId) : ''
  };
}

function parseMoney(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function ExpensesModule() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [month, setMonth] = useState(currentMonth());
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [category, setCategory] = useState<'all' | ExpenseCategory>('all');
  const [data, setData] = useState<ExpenseList>({
    rows: [],
    totals: {
      count: 0,
      totalCve: 0,
      byCategory: [],
      accumulated: { totalCve: 0, count: 0, opexCve: 0, capexCve: 0, opexCount: 0, capexCount: 0, byYear: [] }
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<ExpenseTemplateList>({ rows: [], totals: { count: 0, totalActiveMonthlyCve: 0 } });
  const [templateForm, setTemplateForm] = useState({ name: '', category: 'outros' as ExpenseCategory, amountCve: '', dayOfMonth: '1' });
  const [templateSaving, setTemplateSaving] = useState(false);

  const loadTemplates = () =>
    authFetch('http://127.0.0.1:3001/api/expense-templates')
      .then((r) => r.ok ? r.json() as Promise<ExpenseTemplateList> : { rows: [], totals: { count: 0, totalActiveMonthlyCve: 0 } })
      .then(setTemplates)
      .catch(() => setTemplates({ rows: [], totals: { count: 0, totalActiveMonthlyCve: 0 } }));

  const openTemplates = () => {
    setTemplatesOpen(true);
    void loadTemplates();
  };

  const submitTemplate = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(templateForm.amountCve.replace(',', '.'));
    if (!templateForm.name.trim()) { toast('Indica um nome'); return; }
    if (!Number.isFinite(amount) || amount < 0) { toast('Valor invalido'); return; }
    setTemplateSaving(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/expense-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: templateForm.name.trim(),
          category: templateForm.category,
          amountCve: amount,
          dayOfMonth: Math.max(1, Math.min(28, Number(templateForm.dayOfMonth) || 1))
        })
      });
      if (!response.ok) throw new Error('Nao foi possivel guardar template');
      toast('Template criado');
      setTemplateForm({ name: '', category: 'outros', amountCve: '', dayOfMonth: '1' });
      await loadTemplates();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro');
    } finally {
      setTemplateSaving(false);
    }
  };

  const toggleTemplate = async (template: ExpenseTemplate) => {
    await authFetch(`http://127.0.0.1:3001/api/expense-templates/${template.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: template.name,
        category: template.category,
        amountCve: template.amountCve,
        dayOfMonth: template.dayOfMonth,
        supplier: template.supplier,
        notes: template.notes,
        investmentId: template.investmentId,
        zone: template.zone,
        clientId: template.clientId,
        active: !template.active
      })
    });
    await loadTemplates();
  };

  const deleteTemplate = async (template: ExpenseTemplate) => {
    if (!(await confirm({
      title: 'Apagar template',
      message: `Apagar o template "${template.name}"?`,
      tone: 'danger',
      confirmLabel: 'Apagar'
    }))) return;
    await authFetch(`http://127.0.0.1:3001/api/expense-templates/${template.id}`, { method: 'DELETE' });
    await loadTemplates();
  };

  const runTemplates = async () => {
    const response = await authFetch('http://127.0.0.1:3001/api/expense-templates/run', { method: 'POST' });
    const result = await response.json() as { ran?: true; generated?: number; skipped?: true; reason?: string };
    if (result.ran) {
      toast(`${result.generated} despesa(s) gerada(s)`);
      await load();
      await loadTemplates();
    } else {
      toast(`Saltado: ${result.reason}`);
    }
  };

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/investments?showAll=1')
      .then((r) => r.ok ? r.json() as Promise<InvestmentList> : null)
      .then((payload) => setInvestments(payload?.rows ?? []))
      .catch(() => setInvestments([]));
    authFetch('http://127.0.0.1:3001/api/clients')
      .then((r) => r.ok ? r.json() as Promise<Client[]> : [])
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  const zones = useMemo(() => {
    const set = new Set<string>();
    for (const inv of investments) if (inv.zone) set.add(inv.zone);
    for (const cl of clients) if (cl.zone) set.add(cl.zone);
    return [...set].sort();
  }, [investments, clients]);

  const categoryMeta = useMemo(
    () => Object.fromEntries(CATEGORIES.map((c) => [c.value, c])) as Record<ExpenseCategory, (typeof CATEGORIES)[number]>,
    []
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (!showAllMonths) params.set('month', month);
      if (category !== 'all') params.set('category', category);
      const response = await authFetch(`http://127.0.0.1:3001/api/expenses?${params}`);
      if (!response.ok) throw new Error('Nao foi possivel carregar despesas');
      const payload = (await response.json()) as ExpenseList;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar despesas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, showAllMonths, category]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  };

  const openEdit = (expense: Expense) => {
    setEditing(expense);
    setForm(fromExpense(expense));
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (submitting) return;
    setDialogOpen(false);
    setEditing(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = parseMoney(form.amountCve);
    if (!form.description.trim()) {
      toast('Indica uma descricao para a despesa');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast('Valor invalido');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.expenseDate)) {
      toast('Data invalida');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        category: form.category,
        description: form.description.trim(),
        amountCve: amount,
        expenseDate: form.expenseDate,
        supplier: form.supplier.trim() || null,
        invoiceReference: form.invoiceReference.trim() || null,
        notes: form.notes.trim() || null,
        investmentId: form.allocationTarget === 'investment' && form.investmentId ? Number(form.investmentId) : null,
        zone: form.allocationTarget === 'zone' && form.zone ? form.zone : null,
        clientId: form.allocationTarget === 'client' && form.clientId ? Number(form.clientId) : null
      };
      const url = editing
        ? `http://127.0.0.1:3001/api/expenses/${editing.id}`
        : 'http://127.0.0.1:3001/api/expenses';
      const response = await authFetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || 'Nao foi possivel guardar a despesa');
      }
      toast(editing ? 'Despesa atualizada' : 'Despesa registada');
      setDialogOpen(false);
      setEditing(null);
      setForm(emptyForm());
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao guardar');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (expense: Expense) => {
    if (!(await confirm({
      title: 'Apagar despesa',
      message: `Apagar a despesa "${expense.description}"?`,
      tone: 'danger',
      confirmLabel: 'Apagar'
    }))) return;
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/expenses/${expense.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Nao foi possivel apagar');
      toast('Despesa apagada');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao apagar');
    }
  };

  return (
    <section className="module-panel expenses-module">
      <div className="module-header">
        <div>
          <p className="eyebrow">Painel operacional</p>
          <h2>Despesas operacionais</h2>
        </div>
        <ModuleHeaderActions
          ariaLabel="Ações de despesas"
          secondary={
            <Button variant="secondary" leadingIcon={<Repeat size={16} aria-hidden />} onClick={openTemplates}>
              Recorrentes
            </Button>
          }
          primary={
            <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>
              Nova despesa
            </Button>
          }
        />
      </div>

      <div className="expenses-metrics" aria-label="Resumo de despesas">
        <div>
          <span>Total acumulado (CAPEX + OPEX)</span>
          <strong>{formatCve(data.totals.accumulated.totalCve)}</strong>
          <small>
            CAPEX {formatCve(data.totals.accumulated.capexCve)} · OPEX {formatCve(data.totals.accumulated.opexCve)}
            {data.totals.accumulated.byYear.length > 0 && (
              <>
                {' · por ano: '}
                {data.totals.accumulated.byYear
                  .map((y) => `${y.year} ${formatCve(y.totalCve)}`)
                  .join(', ')}
              </>
            )}
          </small>
        </div>
        <div>
          <span>Filtro actual</span>
          <strong>{formatCve(data.totals.totalCve)}</strong>
          <small>
            {data.totals.count} {data.totals.count === 1 ? 'lançamento' : 'lançamentos'}
            {showAllMonths ? ' · todos os meses' : ` · ${formatPtMonth(month)}`}
          </small>
        </div>
      </div>

      <div className="expenses-filter-shell">
        <FilterBar>
          <Field
            label="Mes"
            type="month"
            value={month}
            disabled={showAllMonths}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
          />
          <Toggle
            className="expenses-toggle-filter"
            title="Todos os meses"
            checked={showAllMonths}
            onChange={(e) => setShowAllMonths(e.target.checked)}
          />
          <Select label="Categoria" value={category} onChange={(e) => setCategory(e.target.value as 'all' | ExpenseCategory)}>
            <option value="all">Todas</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </FilterBar>
      </div>

      {error && !loading && <ErrorRetry message={error} onRetry={() => { void load(); }} />}

      {data.totals.byCategory.length > 0 && (() => {
        const maxTotal = Math.max(1, ...data.totals.byCategory.map((c) => c.totalCve));
        const grandTotal = data.totals.totalCve || 1;
        return (
          <div className="expenses-summary">
            {data.totals.byCategory.map((entry) => {
              const tone = categoryMeta[entry.category as ExpenseCategory]?.tone || 'neutral';
              const pct = (entry.totalCve / grandTotal) * 100;
              const barPct = (entry.totalCve / maxTotal) * 100;
              return (
                <div key={entry.category} className={`expenses-summary-card tone-${tone}`}>
                  <Badge tone={tone}>
                    {categoryMeta[entry.category as ExpenseCategory]?.label || entry.category}
                  </Badge>
                  <strong>{formatCve(entry.totalCve)}</strong>
                  <div className="expenses-summary-bar"><span style={{ width: `${barPct}%` }} /></div>
                  <small>
                    <span>{entry.count} {entry.count === 1 ? 'lançamento' : 'lançamentos'}</span>
                    <span className="pct">{pct.toFixed(1)}%</span>
                  </small>
                </div>
              );
            })}
          </div>
        );
      })()}

      <div className="expenses-list">
      <DataTable
        rows={data.rows}
        rowKey={(expense) => expense.id}
        className="expenses-table"
        gridTemplateColumns="minmax(260px, 1fr) 190px 158px 132px"
        actionsHeader="Ações"
        actionsWidth="92px"
        empty={
          loading
            ? <SkeletonList rows={4} />
            : <div className="module-message">Sem despesas registadas para os filtros atuais.</div>
        }
        columns={[
          {
            header: 'Despesa',
            className: 'expenses-description-cell',
            cell: (expense) => (
              <span className="expenses-row-main">
                <strong>{expense.description}</strong>
                <small>
                  {formatPtDate(expense.expenseDate)}
                  {expense.supplier ? ` · ${expense.supplier}` : ''}
                  {expense.invoiceReference ? ` · ${expense.invoiceReference}` : ''}
                </small>
              </span>
            )
          },
          {
            header: 'Alocacao',
            align: 'center',
            cell: (expense) => {
              const allocLabel = expense.investmentName
                ? `→ ${expense.investmentName}`
                : expense.clientName
                  ? `→ ${expense.clientName}`
                  : expense.zone
                    ? `→ ${expense.zone}`
                    : null;
              return allocLabel ? (
                <Badge tone="info">{allocLabel}</Badge>
              ) : (
                <span className="expenses-alloc-tag">rateio</span>
              );
            }
          },
          {
            header: 'Categoria',
            align: 'center',
            cell: (expense) => (
              <Badge tone={categoryMeta[expense.category]?.tone || 'neutral'}>
                {categoryMeta[expense.category]?.label || expense.category}
              </Badge>
            )
          },
          {
            header: 'Valor',
            align: 'end',
            cell: (expense) => <span className="expenses-amount">{formatCve(expense.amountCve)}</span>
          }
        ]}
        actions={(expense) => (
          <>
            <Button variant="icon" size="sm" title="Editar" aria-label="Editar despesa" onClick={() => openEdit(expense)}>
              <Pencil size={16} aria-hidden />
            </Button>
            <Button
              variant="icon"
              size="sm"
              title="Apagar"
              className="danger-ghost"
              aria-label="Apagar despesa"
              onClick={() => void remove(expense)}
            >
              <Trash2 size={16} aria-hidden />
            </Button>
          </>
        )}
      />
      </div>

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        eyebrow={editing ? 'Editar despesa' : 'Nova despesa'}
        title={editing ? editing.description : 'Registar despesa operacional'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" form="expense-form" loading={submitting}>
              {submitting ? 'A guardar...' : editing ? 'Guardar alteracoes' : 'Registar'}
            </Button>
          </>
        }
      >
        <form id="expense-form" className="expense-form" onSubmit={submit}>
          <div className="expense-form-section">
            <span className="expense-form-section-title">Identificação</span>
            <Field
              wide
              label="Descricao"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              required
              maxLength={240}
              placeholder="Ex: Banda mensal Sotelco"
            />
            <div className="expense-form-grid">
              <Field
                className="col-amount expense-form-amount"
                label="Valor"
                value={form.amountCve}
                onChange={(e) => setForm((f) => ({ ...f, amountCve: e.target.value }))}
                inputMode="decimal"
                required
                placeholder="0"
              />
              <Field
                className="col-date"
                label="Data"
                type="date"
                value={form.expenseDate}
                onChange={(e) => setForm((f) => ({ ...f, expenseDate: e.target.value }))}
                required
              />
              <Select
                className="col-category"
                label="Categoria"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ExpenseCategory }))}
                hint={form.category === 'equipamento' || form.category === 'infraestrutura'
                  ? 'Compra de equipamento/obra é CAPEX — regista no Stock ou em Investimentos para não contar duas vezes. Aqui só custos operacionais (aluguer, manutenção…).'
                  : undefined}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="expense-form-section">
            <span className="expense-form-section-title">Documento</span>
            <div className="expense-form-grid">
              <Field
                className="col-supplier"
                label="Fornecedor"
                value={form.supplier}
                onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))}
                maxLength={160}
                placeholder="Nome ou empresa"
              />
              <Field
                className="col-doc"
                label="Referencia"
                value={form.invoiceReference}
                onChange={(e) => setForm((f) => ({ ...f, invoiceReference: e.target.value }))}
                maxLength={80}
                placeholder="FT-2026/142"
              />
            </div>
          </div>
          <fieldset className="expense-allocation">
            <legend>Alocação (opcional)</legend>
            <small>
              Se ligares a um alvo, o valor vai 100% para esse investimento/zona/cliente em vez de entrar no rateio uniforme.
            </small>
            <div className="expense-allocation-tabs">
              {(['none', 'investment', 'zone', 'client'] as AllocationTarget[]).map((target) => (
                <Button
                  key={target}
                  variant="ghost"
                  size="sm"
                  className={form.allocationTarget === target ? 'active' : ''}
                  onClick={() => setForm((f) => ({ ...f, allocationTarget: target }))}
                >
                  {target === 'none' ? 'Pool (rateio)' : target === 'investment' ? 'Investimento' : target === 'zone' ? 'Zona' : 'Cliente'}
                </Button>
              ))}
            </div>
            {form.allocationTarget === 'investment' && (
              <Select
                wide
                label="Investimento alvo"
                value={form.investmentId}
                onChange={(e) => setForm((f) => ({ ...f, investmentId: e.target.value }))}
              >
                <option value="">Selecionar...</option>
                {investments.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.name}{inv.zone ? ` - ${inv.zone}` : ''}
                  </option>
                ))}
              </Select>
            )}
            {form.allocationTarget === 'zone' && (
              <>
                <Field
                  wide
                  label="Zona alvo"
                  list="expense-zones"
                  value={form.zone}
                  onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))}
                  placeholder="Ex: Palmarejo"
                />
                <datalist id="expense-zones">
                  {zones.map((z) => <option key={z} value={z} />)}
                </datalist>
              </>
            )}
            {form.allocationTarget === 'client' && (
              <label className="field-wide">
                Cliente alvo
                <Combobox
                  options={clients}
                  value={form.clientId ? Number(form.clientId) : null}
                  onChange={(next) => setForm((f) => ({ ...f, clientId: next == null ? '' : String(next) }))}
                  rowKey={(c) => c.id}
                  rowCode={(c) => c.clientCode}
                  rowLabel={(c) => c.fullName}
                  placeholder="Selecionar cliente..."
                />
              </label>
            )}
          </fieldset>
          <Textarea
            label="Notas"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={3}
            maxLength={500}
          />
        </form>
      </Dialog>

      <Dialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        eyebrow="Despesas recorrentes"
        title="Templates mensais"
        size="lg"
        actions={
          <>
            <Button variant="secondary" onClick={() => setTemplatesOpen(false)}>Fechar</Button>
            <Button onClick={() => void runTemplates()}>
              Gerar agora
            </Button>
          </>
        }
      >
        <div className="expense-templates">
          <div className="expense-templates-kpi">
            <div>
              <span className="expense-templates-kpi-label">Total mensal ativo</span>
              <span className="expense-templates-kpi-value">{formatCve(templates.totals.totalActiveMonthlyCve)}</span>
            </div>
            <div className="expense-templates-kpi-meta">
              {templates.rows.filter((t) => t.active === 1).length} ativo(s)
              <br />
              {templates.totals.count} no total
            </div>
          </div>
          <small>
            Cada template ativo gera uma despesa por mês no dia configurado (1–28). A geração é
            idempotente — chamar "Gerar agora" várias vezes não duplica lançamentos.
          </small>

          <form onSubmit={submitTemplate} className="expense-template-form">
            <Field
              wide
              className="full"
              label="Nome"
              value={templateForm.name}
              onChange={(e) => setTemplateForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Ex: Salarios da equipa"
              required
              maxLength={180}
            />
            <Select
              label="Categoria"
              value={templateForm.category}
              onChange={(e) => setTemplateForm((f) => ({ ...f, category: e.target.value as ExpenseCategory }))}
            >
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
            <Field
              label="Valor (CVE)"
              value={templateForm.amountCve}
              onChange={(e) => setTemplateForm((f) => ({ ...f, amountCve: e.target.value }))}
              inputMode="decimal"
              required
              placeholder="0"
            />
            <Field
              label="Dia (1-28)"
              type="number"
              min={1}
              max={28}
              value={templateForm.dayOfMonth}
              onChange={(e) => setTemplateForm((f) => ({ ...f, dayOfMonth: e.target.value }))}
            />
            <Button type="submit" loading={templateSaving}>
              {templateSaving ? 'A guardar...' : 'Adicionar'}
            </Button>
          </form>

          {templates.rows.length === 0 ? (
            <EmptyState
              size="sm"
              icon={FileText}
              title="Sem templates ainda"
              description="Adiciona uma despesa recorrente acima para automatizar lançamentos mensais."
            />
          ) : (
            <ul className="expense-template-list">
              {templates.rows.map((t) => (
                <li key={t.id} className={t.active ? '' : 'inactive'}>
                  <span className="expense-template-day" aria-hidden="true">{t.dayOfMonth}</span>
                  <div className="expense-template-meta">
                    <strong>{t.name}</strong>
                    <span className={`expense-template-status ${t.active ? 'active' : 'paused'}`}>
                      {t.active ? 'Ativo' : 'Pausado'}
                    </span>
                    <small>
                      {categoryMeta[t.category]?.label} · {formatCve(t.amountCve)} · {t.lastGeneratedMonth ? `última geração ${t.lastGeneratedMonth}` : 'nunca gerado'}
                    </small>
                  </div>
                  <div className="expense-template-actions">
                    <Button variant="secondary" size="sm" onClick={() => void toggleTemplate(t)}>
                      {t.active ? 'Pausar' : 'Ativar'}
                    </Button>
                    <Button variant="icon" size="sm" className="danger-ghost" onClick={() => void deleteTemplate(t)}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </section>
  );
}

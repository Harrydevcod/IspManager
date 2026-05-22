import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, DataList, Dialog, FilterBar, Message, useToast } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve } from '../lib/format';
import type { Client, Expense, ExpenseCategory, ExpenseList, Investment, InvestmentList } from '../types';

type AllocationTarget = 'none' | 'investment' | 'zone' | 'client';

const CATEGORIES: { value: ExpenseCategory; label: string; tone: 'success' | 'danger' | 'info' | 'neutral' | 'accent' }[] = [
  { value: 'salarios', label: 'Salarios', tone: 'accent' },
  { value: 'banda_internet', label: 'Banda internet', tone: 'info' },
  { value: 'infraestrutura', label: 'Infraestrutura', tone: 'info' },
  { value: 'equipamento', label: 'Equipamento', tone: 'neutral' },
  { value: 'marketing', label: 'Marketing', tone: 'success' },
  { value: 'impostos', label: 'Impostos', tone: 'danger' },
  { value: 'licencas', label: 'Licencas', tone: 'neutral' },
  { value: 'combustivel', label: 'Combustivel', tone: 'neutral' },
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
  const [month, setMonth] = useState(currentMonth());
  const [showAllMonths, setShowAllMonths] = useState(false);
  const [category, setCategory] = useState<'all' | ExpenseCategory>('all');
  const [data, setData] = useState<ExpenseList>({
    rows: [],
    totals: { count: 0, totalCve: 0, byCategory: [] }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);

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
    if (!window.confirm(`Apagar a despesa "${expense.description}"?`)) return;
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
    <section className="module-panel">
      <div className="module-header">
        <div>
          <h2>Despesas operacionais</h2>
          <small>
            {data.totals.count} {data.totals.count === 1 ? 'lancamento' : 'lancamentos'} ·{' '}
            <strong>{formatCve(data.totals.totalCve)}</strong>
          </small>
        </div>
        <button type="button" className="primary" onClick={openCreate}>
          <Plus size={16} /> Nova despesa
        </button>
      </div>

      <FilterBar>
        <label>
          Mes
          <input
            type="month"
            value={month}
            disabled={showAllMonths}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={showAllMonths}
            onChange={(e) => setShowAllMonths(e.target.checked)}
          />
          Ver todos os meses
        </label>
        <label>
          Categoria
          <select value={category} onChange={(e) => setCategory(e.target.value as 'all' | ExpenseCategory)}>
            <option value="all">Todas</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {error && <Message tone="error">{error}</Message>}

      {data.totals.byCategory.length > 0 && (
        <div className="expenses-summary">
          {data.totals.byCategory.map((entry) => (
            <div key={entry.category} className="expenses-summary-card">
              <Badge tone={categoryMeta[entry.category as ExpenseCategory]?.tone || 'neutral'}>
                {categoryMeta[entry.category as ExpenseCategory]?.label || entry.category}
              </Badge>
              <strong>{formatCve(entry.totalCve)}</strong>
              <small>
                {entry.count} {entry.count === 1 ? 'lancamento' : 'lancamentos'}
              </small>
            </div>
          ))}
        </div>
      )}

      <DataList
        rows={data.rows}
        rowKey={(expense) => expense.id}
        empty={
          <div className="module-message">
            {loading ? 'A carregar...' : 'Sem despesas registadas para os filtros atuais.'}
          </div>
        }
        columns={[
          {
            cell: (expense) => (
              <span>
                <strong>{expense.description}</strong>
                <small>
                  {expense.expenseDate}
                  {expense.supplier ? ` · ${expense.supplier}` : ''}
                  {expense.invoiceReference ? ` · ${expense.invoiceReference}` : ''}
                </small>
              </span>
            )
          },
          {
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
                <small style={{ color: 'var(--text-3)', fontSize: 11 }}>rateio</small>
              );
            }
          },
          {
            cell: (expense) => (
              <Badge tone={categoryMeta[expense.category]?.tone || 'neutral'}>
                {categoryMeta[expense.category]?.label || expense.category}
              </Badge>
            )
          },
          {
            cell: (expense) => <b>{formatCve(expense.amountCve)}</b>
          }
        ]}
        actions={(expense) => (
          <>
            <button type="button" title="Editar" onClick={() => openEdit(expense)}>
              <Pencil size={16} />
            </button>
            <button
              type="button"
              title="Apagar"
              className="danger-ghost"
              onClick={() => void remove(expense)}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}
      />

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        eyebrow={editing ? 'Editar despesa' : 'Nova despesa'}
        title={editing ? editing.description : 'Registar despesa operacional'}
        size="md"
        closeOnBackdrop={!submitting}
        actions={
          <>
            <button type="button" onClick={closeDialog} disabled={submitting}>
              Cancelar
            </button>
            <button type="submit" form="expense-form" className="primary" disabled={submitting}>
              {submitting ? 'A guardar...' : editing ? 'Guardar alteracoes' : 'Registar'}
            </button>
          </>
        }
      >
        <form id="expense-form" className="expense-form" onSubmit={submit}>
          <label className="field-wide">
            Descricao
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              required
              maxLength={240}
              placeholder="Ex: Banda mensal Sotelco"
            />
          </label>
          <div className="expense-form-grid">
            <label>
              Categoria
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ExpenseCategory }))}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Valor (CVE)
              <input
                value={form.amountCve}
                onChange={(e) => setForm((f) => ({ ...f, amountCve: e.target.value }))}
                inputMode="decimal"
                required
                placeholder="0"
              />
            </label>
            <label>
              Data
              <input
                type="date"
                value={form.expenseDate}
                onChange={(e) => setForm((f) => ({ ...f, expenseDate: e.target.value }))}
                required
              />
            </label>
            <label>
              Fornecedor
              <input
                value={form.supplier}
                onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))}
                maxLength={160}
              />
            </label>
            <label>
              Documento / Referencia
              <input
                value={form.invoiceReference}
                onChange={(e) => setForm((f) => ({ ...f, invoiceReference: e.target.value }))}
                maxLength={80}
                placeholder="FT-2026/142"
              />
            </label>
          </div>
          <fieldset className="expense-allocation">
            <legend>Alocação (opcional)</legend>
            <small>
              Se ligares a um alvo, o valor vai 100% para esse investimento/zona/cliente em vez de entrar no rateio uniforme.
            </small>
            <div className="expense-allocation-tabs">
              {(['none', 'investment', 'zone', 'client'] as AllocationTarget[]).map((target) => (
                <button
                  key={target}
                  type="button"
                  className={form.allocationTarget === target ? 'active' : ''}
                  onClick={() => setForm((f) => ({ ...f, allocationTarget: target }))}
                >
                  {target === 'none' ? 'Pool (rateio)' : target === 'investment' ? 'Investimento' : target === 'zone' ? 'Zona' : 'Cliente'}
                </button>
              ))}
            </div>
            {form.allocationTarget === 'investment' && (
              <label className="field-wide">
                Investimento alvo
                <select
                  value={form.investmentId}
                  onChange={(e) => setForm((f) => ({ ...f, investmentId: e.target.value }))}
                >
                  <option value="">Selecionar...</option>
                  {investments.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.name}{inv.zone ? ` · ${inv.zone}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {form.allocationTarget === 'zone' && (
              <label className="field-wide">
                Zona alvo
                <input
                  list="expense-zones"
                  value={form.zone}
                  onChange={(e) => setForm((f) => ({ ...f, zone: e.target.value }))}
                  placeholder="Ex: Palmarejo"
                />
                <datalist id="expense-zones">
                  {zones.map((z) => <option key={z} value={z} />)}
                </datalist>
              </label>
            )}
            {form.allocationTarget === 'client' && (
              <label className="field-wide">
                Cliente alvo
                <select
                  value={form.clientId}
                  onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
                >
                  <option value="">Selecionar...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.fullName}{c.clientCode ? ` · ${c.clientCode}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <label className="field-wide">
            Notas
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              maxLength={500}
            />
          </label>
        </form>
      </Dialog>
    </section>
  );
}

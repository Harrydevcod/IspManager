import { Activity, Cable, Pencil, Plus, Tags, Wifi } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, Field, FilterBar, ModuleHeaderActions, Select, SkeletonList, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { formatCve } from '../lib/format';
import type { PlanRow } from '../types';
import { RepriceDialog } from './plans/RepriceDialog';
import './PlansModule.css';

type PlanFormState = {
  name: string;
  downloadSpeed: string;
  uploadSpeed: string;
  downloadMbps: string;
  uploadMbps: string;
  connectionType: 'radio' | 'fibra' | 'cabo' | 'outro';
  monthlyPriceCve: string;
  installationFeeCve: string;
  description: string;
  active: '1' | '0';
};

function emptyPlanForm(): PlanFormState {
  return {
    name: '',
    downloadSpeed: '',
    uploadSpeed: '',
    downloadMbps: '',
    uploadMbps: '',
    connectionType: 'fibra',
    monthlyPriceCve: '',
    installationFeeCve: '',
    description: '',
    active: '1'
  };
}

function iconForType(type: PlanRow['connectionType']): LucideIcon {
  switch (type) {
    case 'fibra': return Cable;
    case 'cabo':  return Cable;
    case 'radio': return Wifi;
    default:      return Activity;
  }
}

function typeLabel(type: PlanRow['connectionType']): string {
  switch (type) {
    case 'fibra': return 'Fibra';
    case 'cabo':  return 'Cabo';
    case 'radio': return 'Rádio';
    default:      return 'Outro';
  }
}

/** "100/50" → "100/50 Mbps"; keeps whatever unit the user typed if present. */
export function speedDisplay(plan: PlanRow): { value: string; unit: string } {
  // Os Mbps numericos sao a fonte de verdade desde a migracao 0041; o texto
  // legado ("20 Mb/s") so aparece em planos que ainda nao foram convertidos.
  if (plan.downloadMbps != null && plan.uploadMbps != null) {
    return { value: `${plan.downloadMbps}/${plan.uploadMbps}`, unit: 'Mbps' };
  }
  const value = `${plan.downloadSpeed}/${plan.uploadSpeed}`;
  const userSuppliedUnit = /[a-zA-Z]/.test(plan.downloadSpeed + plan.uploadSpeed);
  return { value, unit: userSuppliedUnit ? '' : 'Mbps' };
}

export function PlansModule() {
  const { toast } = useToast();
  const auth = useAuth();
  const canManagePlans = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const [plans, setPlans] = useState<PlanRow[]>([]);
  // Só admin alinha preços: mexe na fatura de dezenas de clientes de uma vez.
  const canReprice = auth.isAuthBypassed || auth.hasRole('admin');
  const [repricePlan, setRepricePlan] = useState<PlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | PlanRow['connectionType']>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [form, setForm] = useState<PlanFormState>(emptyPlanForm());

  function loadPlans() {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/plans')
      .then((response) => response.json() as Promise<PlanRow[]>)
      .then((data) => { setPlans(data); setLoadError(null); })
      .catch(() => { setPlans([]); setLoadError('Não foi possível carregar os planos.'); })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  function updateForm(field: keyof PlanFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function openCreate() {
    setEditingPlan(null);
    setForm(emptyPlanForm());
    setShowForm(true);
  }

  function editPlan(plan: PlanRow) {
    setEditingPlan(plan);
    setForm({
      name: plan.name,
      downloadSpeed: plan.downloadSpeed,
      uploadSpeed: plan.uploadSpeed,
      downloadMbps: plan.downloadMbps == null ? '' : String(plan.downloadMbps),
      uploadMbps: plan.uploadMbps == null ? '' : String(plan.uploadMbps),
      connectionType: plan.connectionType,
      monthlyPriceCve: String(plan.monthlyPriceCve),
      installationFeeCve: String(plan.installationFeeCve),
      description: plan.description || '',
      active: plan.active ? '1' : '0'
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingPlan(null);
    setForm(emptyPlanForm());
  }

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = editingPlan ? `http://127.0.0.1:3001/api/plans/${editingPlan.id}` : 'http://127.0.0.1:3001/api/plans';
    const response = await authFetch(url, {
      method: editingPlan ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        monthlyPriceCve: Number(form.monthlyPriceCve),
        installationFeeCve: Number(form.installationFeeCve || 0),
        // Vazio = sem limite definido: o router fica como esta, em vez de
        // receber um zero que cortaria a velocidade toda.
        downloadMbps: form.downloadMbps ? Number(form.downloadMbps) : null,
        uploadMbps: form.uploadMbps ? Number(form.uploadMbps) : null,
        active: form.active === '1'
      })
    });

    if (!response.ok) {
      toast(editingPlan ? 'Nao foi possivel atualizar o plano.' : 'Nao foi possivel criar o plano.', 'error');
      return;
    }

    toast(editingPlan ? 'Plano atualizado.' : 'Plano criado.', 'success');
    closeForm();
    await loadPlans();
  }

  const visiblePlans = useMemo(() => plans.filter((plan) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || plan.name.toLowerCase().includes(normalizedSearch)
      || plan.downloadSpeed.toLowerCase().includes(normalizedSearch)
      || plan.uploadSpeed.toLowerCase().includes(normalizedSearch);
    const matchesType = typeFilter === 'all' || plan.connectionType === typeFilter;
    const matchesActive = activeFilter === 'all'
      || (activeFilter === 'active' && !!plan.active)
      || (activeFilter === 'inactive' && !plan.active);
    return matchesSearch && matchesType && matchesActive;
  }), [plans, search, typeFilter, activeFilter]);

  const totals = useMemo(() => {
    const active = plans.filter((p) => p.active).length;
    return { active, inactive: plans.length - active, total: plans.length };
  }, [plans]);

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Planos de internet</h2>
          <p className="plans-header-subtitle">
            <strong>{totals.active}</strong> ativos
            {totals.inactive > 0 && <> · <strong>{totals.inactive}</strong> inativos</>}
          </p>
        </div>
        {canManagePlans && (
          <ModuleHeaderActions
            ariaLabel="Ações de planos"
            primary={
              <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={openCreate}>
                Novo plano
              </Button>
            }
          />
        )}
      </div>

      <div className="plans-filter-sticky">
        {loadError && plans.length === 0 && <ErrorRetry message={loadError} onRetry={() => { void loadPlans(); }} />}
        <FilterBar>
          <Field
            type="search"
            label="Buscar"
            aria-label="Pesquisar planos"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nome ou velocidade"
          />
          <Select
            label="Tipo"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as 'all' | PlanRow['connectionType'])}
          >
            <option value="all">Todos</option>
            <option value="fibra">Fibra</option>
            <option value="radio">Rádio</option>
            <option value="cabo">Cabo</option>
            <option value="outro">Outro</option>
          </Select>
          <Select
            label="Estado"
            value={activeFilter}
            onChange={(event) => setActiveFilter(event.target.value as 'all' | 'active' | 'inactive')}
          >
            <option value="all">Todos</option>
            <option value="active">Ativos</option>
            <option value="inactive">Inativos</option>
          </Select>
          <Button variant="secondary" onClick={() => { setSearch(''); setTypeFilter('all'); setActiveFilter('all'); }}>
            Limpar filtros
          </Button>
          <small>{visiblePlans.length} {visiblePlans.length === 1 ? 'plano' : 'planos'}</small>
        </FilterBar>
      </div>

      {loading && plans.length === 0 && <SkeletonList rows={6} />}

      {!loading && visiblePlans.length === 0 && (
        <EmptyState
          icon={Wifi}
          title="Nenhum plano encontrado"
          description="Ajusta os filtros ou cria um novo plano de internet."
        />
      )}

      {visiblePlans.length > 0 && (
        <DataTable
          className="plans-table"
          rows={visiblePlans}
          rowKey={(plan) => plan.id}
          stickyHeader
          onRowClick={canManagePlans ? editPlan : undefined}
          gridTemplateColumns="minmax(160px, 1.5fr) 120px 150px 140px 110px"
          actionsWidth="96px"
          columns={[
            { header: 'Nome', cell: (plan) => <strong>{plan.name}</strong> },
            {
              header: 'Tipo',
              cell: (plan) => {
                const Icon = iconForType(plan.connectionType);
                return (
                  <span className="plans-type">
                    <Icon size={14} strokeWidth={1.6} aria-hidden />
                    {typeLabel(plan.connectionType)}
                  </span>
                );
              }
            },
            {
              header: 'Velocidade ↓/↑',
              align: 'end',
              cell: (plan) => {
                const speed = speedDisplay(plan);
                return <b>{speed.value}{speed.unit ? ` ${speed.unit}` : ''}</b>;
              }
            },
            { header: 'Preço/mês', align: 'end', cell: (plan) => <b>{formatCve(plan.monthlyPriceCve)}</b> },
            {
              header: 'Estado',
              align: 'center',
              cell: (plan) => <Badge tone={plan.active ? 'success' : 'neutral'}>{plan.active ? 'Ativo' : 'Inativo'}</Badge>
            }
          ]}
          actions={canManagePlans ? (plan) => (
            <>
              {canReprice && (
                <Button
                  variant="icon"
                  size="sm"
                  title="Aplicar este preço aos serviços ativos"
                  aria-label={`Aplicar preço do plano ${plan.name} aos serviços ativos`}
                  onClick={() => setRepricePlan(plan)}
                >
                  <Tags size={14} aria-hidden />
                </Button>
              )}
              <Button
                variant="icon"
                size="sm"
                title="Editar plano"
                aria-label={`Editar plano ${plan.name}`}
                onClick={() => editPlan(plan)}
              >
                <Pencil size={14} aria-hidden />
              </Button>
            </>
          ) : undefined}
          empty={null}
        />
      )}

      <Dialog
        open={showForm}
        onClose={closeForm}
        eyebrow={editingPlan ? 'Editar plano' : 'Novo plano'}
        title={editingPlan ? editingPlan.name : 'Plano de internet'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" form="plan-form">
              {editingPlan ? 'Atualizar plano' : 'Gravar plano'}
            </Button>
          </>
        }
      >
        <form id="plan-form" className="client-form" onSubmit={savePlan}>
          <Field label="Nome" required value={form.name} onChange={(event) => updateForm('name', event.target.value)} />
          <Select label="Tipo" value={form.connectionType} onChange={(event) => updateForm('connectionType', event.target.value)}>
            <option value="fibra">Fibra</option>
            <option value="radio">Rádio</option>
            <option value="cabo">Cabo</option>
            <option value="outro">Outro</option>
          </Select>
          <Field label="Download" required value={form.downloadSpeed} onChange={(event) => updateForm('downloadSpeed', event.target.value)} />
          <Field label="Upload" required value={form.uploadSpeed} onChange={(event) => updateForm('uploadSpeed', event.target.value)} />
          <Field
            label="Download (Mbps)"
            type="number"
            min={1}
            max={10000}
            value={form.downloadMbps}
            onChange={(event) => updateForm('downloadMbps', event.target.value)}
            hint="Número usado para limitar a velocidade no router. Em branco, o router fica como está."
          />
          <Field
            label="Upload (Mbps)"
            type="number"
            min={1}
            max={10000}
            value={form.uploadMbps}
            onChange={(event) => updateForm('uploadMbps', event.target.value)}
            hint="Idem. Os dois campos são precisos para o limite ser aplicado."
          />
          <Field label="Mensalidade CVE" required type="number" min={0} value={form.monthlyPriceCve} onChange={(event) => updateForm('monthlyPriceCve', event.target.value)} />
          <Field label="Instalacao CVE" type="number" min={0} value={form.installationFeeCve} onChange={(event) => updateForm('installationFeeCve', event.target.value)} />
          <Field wide label="Descricao" value={form.description} onChange={(event) => updateForm('description', event.target.value)} />
          <Select label="Estado" value={form.active} onChange={(event) => updateForm('active', event.target.value)}>
            <option value="1">Ativo</option>
            <option value="0">Inativo</option>
          </Select>
        </form>
      </Dialog>

      {repricePlan && (
        <RepriceDialog
          planId={repricePlan.id}
          planName={repricePlan.name}
          onClose={() => setRepricePlan(null)}
          onApplied={(updated) => {
            setRepricePlan(null);
            toast(
              updated === 0
                ? 'Todos os serviços já estavam alinhados com o preço do plano.'
                : `${updated} serviço(s) alinhado(s) ao preço do plano.`,
              'success'
            );
            void loadPlans();
          }}
        />
      )}
    </section>
  );
}

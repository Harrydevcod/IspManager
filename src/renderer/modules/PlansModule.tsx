import { Pencil } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Field, FilterBar, Message, Select, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { planActiveLabel, planActiveTone } from '../lib/status';
import type { PlanRow } from '../types';

type PlanFormState = {
  name: string;
  downloadSpeed: string;
  uploadSpeed: string;
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
    connectionType: 'fibra',
    monthlyPriceCve: '',
    installationFeeCve: '',
    description: '',
    active: '1'
  };
}

export function PlansModule() {
  const { toast } = useToast();
  const auth = useAuth();
  const canManagePlans = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | PlanRow['connectionType']>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [form, setForm] = useState<PlanFormState>(emptyPlanForm());

  function loadPlans() {
    return authFetch('http://127.0.0.1:3001/api/plans')
      .then((response) => response.json() as Promise<PlanRow[]>)
      .then(setPlans)
      .catch(() => setPlans([]));
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

  const visiblePlans = plans.filter((plan) => {
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
  });

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Planos de internet</h2>
        </div>
        {canManagePlans && (
          <Button onClick={openCreate}>
            Novo plano
          </Button>
        )}
      </div>

      <FilterBar>
        <Field type="search" label="Buscar" aria-label="Pesquisar planos" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome ou velocidade" />
        <Select label="Tipo" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | PlanRow['connectionType'])}>
          <option value="all">Todos</option>
          <option value="fibra">Fibra</option>
          <option value="radio">Radio</option>
          <option value="cabo">Cabo</option>
          <option value="outro">Outro</option>
        </Select>
        <Select label="Estado" value={activeFilter} onChange={(event) => setActiveFilter(event.target.value as 'all' | 'active' | 'inactive')}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
        </Select>
        <Button variant="secondary" onClick={() => {
          setSearch('');
          setTypeFilter('all');
          setActiveFilter('all');
        }}>
          Limpar filtros
        </Button>
        <small>{visiblePlans.length} planos</small>
      </FilterBar>

      <div className="module-table">
        {visiblePlans.map((plan) => (
          <div
            className="module-row plan-row interactive"
            key={plan.id}
            role="button"
            tabIndex={0}
            onClick={() => { if (canManagePlans) editPlan(plan); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (canManagePlans) editPlan(plan);
              }
            }}
          >
            <span>
              <strong>{plan.name}</strong>
              <small>{plan.connectionType} - {plan.downloadSpeed}/{plan.uploadSpeed}</small>
            </span>
            <small>{plan.monthlyPriceCve.toLocaleString('pt-PT')} CVE</small>
            <Badge tone={planActiveTone(plan.active)}>{planActiveLabel(plan.active)}</Badge>
            {canManagePlans && (
              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <Button
                  variant="icon"
                  size="sm"
                  className="row-action"
                  title="Editar plano"
                  aria-label="Editar plano"
                  onClick={(event) => {
                    event.stopPropagation();
                    editPlan(plan);
                  }}
                >
                  <Pencil size={14} aria-hidden />
                </Button>
              </div>
            )}
          </div>
        ))}
        {visiblePlans.length === 0 && (
          <Message>Nenhum plano encontrado para os filtros atuais.</Message>
        )}
      </div>

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
            <option value="radio">Radio</option>
            <option value="cabo">Cabo</option>
            <option value="outro">Outro</option>
          </Select>
          <Field label="Download" required value={form.downloadSpeed} onChange={(event) => updateForm('downloadSpeed', event.target.value)} />
          <Field label="Upload" required value={form.uploadSpeed} onChange={(event) => updateForm('uploadSpeed', event.target.value)} />
          <Field label="Mensalidade CVE" required type="number" min={0} value={form.monthlyPriceCve} onChange={(event) => updateForm('monthlyPriceCve', event.target.value)} />
          <Field label="Instalacao CVE" type="number" min={0} value={form.installationFeeCve} onChange={(event) => updateForm('installationFeeCve', event.target.value)} />
          <Field wide label="Descricao" value={form.description} onChange={(event) => updateForm('description', event.target.value)} />
          <Select label="Estado" value={form.active} onChange={(event) => updateForm('active', event.target.value)}>
            <option value="1">Ativo</option>
            <option value="0">Inativo</option>
          </Select>
        </form>
      </Dialog>
    </section>
  );
}

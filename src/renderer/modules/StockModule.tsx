import { Activity, ArrowDownUp, Banknote, Boxes, Gauge, Pencil, Users } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Field, FilterBar, Message, Select, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { stockLevelTone } from '../lib/status';
import type { CatalogAssignments, StockCatalogRow, StockMovement, StockSummary } from '../types';

type StockFormState = {
  type: 'cpe' | 'router' | 'antena' | 'switch' | 'outro';
  brand: string;
  model: string;
  supplier: string;
  purchasePriceCve: string;
  sellingPriceCve: string;
  rentalFeeCve: string;
  stockTotal: string;
  active: '1' | '0';
};

type StockMovementFormState = {
  type: 'entrada' | 'saida' | 'ajuste';
  quantity: string;
  unitCostCve: string;
  supplier: string;
  reference: string;
  notes: string;
};

function emptyCatalogForm(): StockFormState {
  return {
    type: 'router',
    brand: '',
    model: '',
    supplier: '',
    purchasePriceCve: '',
    sellingPriceCve: '',
    rentalFeeCve: '',
    stockTotal: '0',
    active: '1'
  };
}

function emptyMovementForm(): StockMovementFormState {
  return { type: 'entrada', quantity: '1', unitCostCve: '', supplier: '', reference: '', notes: '' };
}

export function StockModule() {
  const { toast } = useToast();
  const auth = useAuth();
  const canManageStock = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [selectedCatalog, setSelectedCatalog] = useState<StockCatalogRow | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [assignments, setAssignments] = useState<CatalogAssignments | null>(null);
  const [showCatalogForm, setShowCatalogForm] = useState(false);
  const [showMovementForm, setShowMovementForm] = useState(false);
  const [editingCatalog, setEditingCatalog] = useState<StockCatalogRow | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | StockCatalogRow['type']>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [catalogForm, setCatalogForm] = useState<StockFormState>(emptyCatalogForm());
  const [movementForm, setMovementForm] = useState<StockMovementFormState>(emptyMovementForm());

  function loadStock() {
    return authFetch('http://127.0.0.1:3001/api/stock/summary')
      .then((response) => response.json() as Promise<StockSummary>)
      .then(setSummary)
      .catch(() => setSummary(null));
  }

  function loadMovements(catalog: StockCatalogRow) {
    return authFetch(`http://127.0.0.1:3001/api/stock?catalogId=${catalog.id}`)
      .then((response) => response.json() as Promise<{ movements: StockMovement[] }>)
      .then((data) => setMovements(data.movements))
      .catch(() => setMovements([]));
  }

  function loadAssignments(catalog: StockCatalogRow) {
    return authFetch(`http://127.0.0.1:3001/api/equipment-catalog/${catalog.id}/assignments`)
      .then((response) => response.json() as Promise<CatalogAssignments>)
      .then((data) => setAssignments(data))
      .catch(() => setAssignments(null));
  }

  function selectCatalog(catalog: StockCatalogRow) {
    setSelectedCatalog(catalog);
    setAssignments(null);
    void loadMovements(catalog);
    void loadAssignments(catalog);
  }

  useEffect(() => {
    void loadStock();
  }, []);

  function updateCatalogForm(field: keyof StockFormState, value: string) {
    setCatalogForm((current) => ({ ...current, [field]: value }));
  }

  function updateMovementForm(field: keyof StockMovementFormState, value: string) {
    setMovementForm((current) => ({ ...current, [field]: value }));
  }

  function openCreateCatalog() {
    setEditingCatalog(null);
    setCatalogForm(emptyCatalogForm());
    setShowCatalogForm(true);
  }

  function editCatalog(catalog: StockCatalogRow) {
    setEditingCatalog(catalog);
    setCatalogForm({
      type: catalog.type,
      brand: catalog.brand || '',
      model: catalog.model,
      supplier: catalog.supplier || '',
      purchasePriceCve: String(catalog.purchasePriceCve),
      sellingPriceCve: String(catalog.sellingPriceCve),
      rentalFeeCve: String(catalog.rentalFeeCve),
      stockTotal: String(catalog.stockTotal),
      active: catalog.active ? '1' : '0'
    });
    setShowCatalogForm(true);
  }

  function closeCatalogForm() {
    setEditingCatalog(null);
    setShowCatalogForm(false);
    setCatalogForm(emptyCatalogForm());
  }

  function openMovementForm() {
    setMovementForm(emptyMovementForm());
    setShowMovementForm(true);
  }

  function closeMovementForm() {
    setShowMovementForm(false);
    setMovementForm(emptyMovementForm());
  }

  async function saveCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = editingCatalog ? `http://127.0.0.1:3001/api/equipment-catalog/${editingCatalog.id}` : 'http://127.0.0.1:3001/api/equipment-catalog';
    const response = await authFetch(url, {
      method: editingCatalog ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...catalogForm,
        purchasePriceCve: Number(catalogForm.purchasePriceCve || 0),
        sellingPriceCve: Number(catalogForm.sellingPriceCve || 0),
        rentalFeeCve: Number(catalogForm.rentalFeeCve || 0),
        stockTotal: Number(catalogForm.stockTotal || 0),
        active: catalogForm.active === '1'
      })
    });

    if (!response.ok) {
      toast(editingCatalog ? 'Nao foi possivel atualizar o equipamento.' : 'Nao foi possivel criar o equipamento.', 'error');
      return;
    }

    toast(editingCatalog ? 'Equipamento atualizado.' : 'Equipamento criado no catalogo.', 'success');
    if (editingCatalog && catalogForm.active === '0') {
      setSelectedCatalog(null);
    }
    closeCatalogForm();
    await loadStock();
  }

  async function createMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCatalog) {
      return;
    }

    const response = await authFetch('http://127.0.0.1:3001/api/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...movementForm,
        catalogId: selectedCatalog.id,
        quantity: Number(movementForm.quantity),
        unitCostCve: Number(movementForm.unitCostCve || 0)
      })
    });

    if (!response.ok) {
      const result = await response.json() as { error?: string };
      toast(result.error || 'Nao foi possivel registar o movimento.', 'error');
      return;
    }

    toast('Movimento registado.', 'success');
    closeMovementForm();
    await loadStock();
    await loadMovements(selectedCatalog);
  }

  const totals = summary?.totals;
  const visibleStockRows = (summary?.rows || []).filter((item) => {
    const normalizedSearch = search.trim().toLowerCase();
    const label = `${item.brand || ''} ${item.model} ${item.supplier || ''}`.toLowerCase();
    const matchesSearch = !normalizedSearch || label.includes(normalizedSearch);
    const matchesType = typeFilter === 'all' || item.type === typeFilter;
    const matchesStock = stockFilter === 'all'
      || (stockFilter === 'low' && item.stockTotal > 0 && item.stockTotal <= 3)
      || (stockFilter === 'out' && item.stockTotal <= 0);
    return matchesSearch && matchesType && matchesStock;
  });

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Stock</h2>
        </div>
        {canManageStock && (
          <Button onClick={openCreateCatalog}>
            Novo equipamento
          </Button>
        )}
      </div>

      <FilterBar>
        <Field type="search" label="Buscar" aria-label="Pesquisar stock" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Marca, modelo ou fornecedor" />
        <Select label="Tipo" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | StockCatalogRow['type'])}>
          <option value="all">Todos</option>
          <option value="cpe">CPE</option>
          <option value="router">Router</option>
          <option value="antena">Antena</option>
          <option value="switch">Switch</option>
          <option value="outro">Outro</option>
        </Select>
        <Select label="Stock" value={stockFilter} onChange={(event) => setStockFilter(event.target.value as 'all' | 'low' | 'out')}>
          <option value="all">Todos</option>
          <option value="low">Baixo</option>
          <option value="out">Esgotado</option>
        </Select>
        <Button variant="secondary" onClick={() => {
          setSearch('');
          setTypeFilter('all');
          setStockFilter('all');
        }}>
          Limpar filtros
        </Button>
        <small>{visibleStockRows.length} modelos</small>
      </FilterBar>

      <section className="metric-grid compact" aria-label="Resumo de stock">
        <article className="metric-card">
          <Boxes size={20} />
          <span>Modelos</span>
          <strong>{totals ? totals.models : '...'}</strong>
          <small>catalogo ativo</small>
        </article>
        <article className="metric-card">
          <Activity size={20} />
          <span>Unidades</span>
          <strong>{totals ? totals.available : '...'}</strong>
          <small>disponiveis</small>
        </article>
        <article className="metric-card">
          <Gauge size={20} />
          <span>Stock baixo</span>
          <strong>{totals ? totals.lowStock : '...'}</strong>
          <small>3 unidades ou menos</small>
        </article>
        <article className="metric-card">
          <Banknote size={20} />
          <span>Valor</span>
          <strong>{totals ? totals.inventoryValueCve.toLocaleString('pt-PT') : '...'}</strong>
          <small>CVE em stock</small>
        </article>
      </section>

      {selectedCatalog && (
        <div className="client-detail">
          <div className="module-header">
            <div>
              <p className="eyebrow">Equipamento selecionado</p>
              <h2>{selectedCatalog.brand ? `${selectedCatalog.brand} ${selectedCatalog.model}` : selectedCatalog.model}</h2>
            </div>
            {canManageStock && (
              <div className="inline-actions">
                <Button variant="secondary" size="sm" onClick={() => editCatalog(selectedCatalog)}>Editar</Button>
                <Button size="sm" onClick={openMovementForm}>Movimento</Button>
              </div>
            )}
          </div>
          <dl>
            <div><dt>Tipo</dt><dd>{selectedCatalog.type}</dd></div>
            <div><dt>Stock</dt><dd>{selectedCatalog.stockTotal}</dd></div>
            <div><dt>Atribuidos</dt><dd>{assignments ? assignments.activeCount : '-'}</dd></div>
            <div><dt>Custo</dt><dd>{selectedCatalog.landedCostCve.toLocaleString('pt-PT')} CVE</dd></div>
            <div><dt>Venda</dt><dd>{selectedCatalog.sellingPriceCve.toLocaleString('pt-PT')} CVE</dd></div>
            <div><dt>Aluguer</dt><dd>{selectedCatalog.rentalFeeCve.toLocaleString('pt-PT')} CVE</dd></div>
          </dl>

          <section className="technical-section">
            <header className="technical-section-head">
              <h3><Users size={14} aria-hidden /> Atribuido a</h3>
              {assignments && (
                <span className="muted">
                  {assignments.activeCount} ativo(s) - {assignments.totalCount} no historico
                </span>
              )}
            </header>
            {!assignments && <Message>A carregar...</Message>}
            {assignments && assignments.items.length === 0 && (
              <Message>Este modelo ainda nao foi atribuido a nenhum servico.</Message>
            )}
            {assignments && assignments.items.length > 0 && (
              <ul className="technical-list">
                {assignments.items.map((row) => {
                  const active = !row.endDate;
                  return (
                    <li key={row.id} className={`technical-item ${active ? 'active' : 'past'}`}>
                      <div className="technical-item-head">
                        <div className="technical-item-identity">
                          <small className="entity-code">{row.clientCode}</small>
                          <strong>{row.clientName}</strong>
                        </div>
                        <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Ativo' : 'Devolvido'}</Badge>
                      </div>
                      <dl className="technical-item-meta">
                        {row.serialNumber && <div><dt>Serial</dt><dd>{row.serialNumber}</dd></div>}
                        {row.assetTag && <div><dt>Asset</dt><dd>{row.assetTag}</dd></div>}
                        {row.macAddress && <div><dt>MAC</dt><dd>{row.macAddress}</dd></div>}
                        {row.ipAddress && <div><dt>IP</dt><dd>{row.ipAddress}</dd></div>}
                        <div><dt>Desde</dt><dd>{new Date(row.startDate).toLocaleDateString('pt-PT')}</dd></div>
                        {row.endDate && (
                          <div><dt>Devolvido</dt><dd>{new Date(row.endDate).toLocaleDateString('pt-PT')}</dd></div>
                        )}
                      </dl>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="module-table">
            {movements.slice(0, 8).map((movement) => (
              <div className="module-row stock-movement-row" key={movement.id}>
                <strong>{movement.type}</strong>
                <span>{movement.quantity}</span>
                <small>{movement.reference || movement.notes || '-'}</small>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="module-table">
        {visibleStockRows.map((item) => (
          <div
            className="module-row stock-row interactive"
            key={item.id}
            role="button"
            tabIndex={0}
            onClick={() => selectCatalog(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectCatalog(item);
              }
            }}
          >
            <span>
              <strong>{item.brand ? `${item.brand} ${item.model}` : item.model}</strong>
              <small>{item.type} - {item.supplier || 'sem fornecedor'}</small>
            </span>
            <Badge tone={stockLevelTone(item.stockTotal)}>{item.stockTotal} un.</Badge>
            {canManageStock && (
              <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                <Button
                  variant="icon"
                  size="sm"
                  className="row-action"
                  title="Editar equipamento"
                  aria-label="Editar equipamento"
                  onClick={(event) => {
                    event.stopPropagation();
                    editCatalog(item);
                  }}
                >
                  <Pencil size={14} aria-hidden />
                </Button>
                <Button
                  variant="icon"
                  size="sm"
                  className="row-action"
                  title="Novo movimento"
                  aria-label="Novo movimento"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectCatalog(item);
                    openMovementForm();
                  }}
                >
                  <ArrowDownUp size={14} aria-hidden />
                </Button>
              </div>
            )}
          </div>
        ))}
        {summary && visibleStockRows.length === 0 && (
          <EmptyState
            icon={Boxes}
            title="Nenhum equipamento encontrado"
            description="Ajusta os filtros ou cadastra um novo equipamento no catálogo."
          />
        )}
      </div>

      <Dialog
        open={showCatalogForm}
        onClose={closeCatalogForm}
        eyebrow={editingCatalog ? 'Editar equipamento' : 'Novo equipamento'}
        title={editingCatalog ? (editingCatalog.brand ? `${editingCatalog.brand} ${editingCatalog.model}` : editingCatalog.model) : 'Equipamento'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeCatalogForm}>Cancelar</Button>
            <Button type="submit" form="catalog-form">
              {editingCatalog ? 'Atualizar equipamento' : 'Gravar equipamento'}
            </Button>
          </>
        }
      >
        <form id="catalog-form" className="client-form" onSubmit={saveCatalog}>
          <Select label="Tipo" value={catalogForm.type} onChange={(event) => updateCatalogForm('type', event.target.value)}>
            <option value="cpe">CPE</option>
            <option value="router">Router</option>
            <option value="antena">Antena</option>
            <option value="switch">Switch</option>
            <option value="outro">Outro</option>
          </Select>
          <Field label="Marca" value={catalogForm.brand} onChange={(event) => updateCatalogForm('brand', event.target.value)} />
          <Field label="Modelo" required value={catalogForm.model} onChange={(event) => updateCatalogForm('model', event.target.value)} />
          <Field label="Fornecedor" value={catalogForm.supplier} onChange={(event) => updateCatalogForm('supplier', event.target.value)} />
          <Field label="Custo compra CVE" type="number" min={0} value={catalogForm.purchasePriceCve} onChange={(event) => updateCatalogForm('purchasePriceCve', event.target.value)} />
          <Field label="Preco venda CVE" type="number" min={0} value={catalogForm.sellingPriceCve} onChange={(event) => updateCatalogForm('sellingPriceCve', event.target.value)} />
          <Field label="Aluguer mensal CVE" type="number" min={0} value={catalogForm.rentalFeeCve} onChange={(event) => updateCatalogForm('rentalFeeCve', event.target.value)} />
          <Field label={editingCatalog ? 'Stock atual' : 'Stock inicial'} type="number" min={0} value={catalogForm.stockTotal} onChange={(event) => updateCatalogForm('stockTotal', event.target.value)} />
          <Select label="Estado" value={catalogForm.active} onChange={(event) => updateCatalogForm('active', event.target.value)}>
            <option value="1">Ativo</option>
            <option value="0">Inativo</option>
          </Select>
        </form>
      </Dialog>

      <Dialog
        open={showMovementForm && !!selectedCatalog}
        onClose={closeMovementForm}
        eyebrow="Novo movimento"
        title={selectedCatalog ? (selectedCatalog.brand ? `${selectedCatalog.brand} ${selectedCatalog.model}` : selectedCatalog.model) : 'Movimento'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeMovementForm}>Cancelar</Button>
            <Button type="submit" form="movement-form">Registar</Button>
          </>
        }
      >
        <form id="movement-form" className="client-form" onSubmit={createMovement}>
          <Select label="Tipo" value={movementForm.type} onChange={(event) => updateMovementForm('type', event.target.value)}>
            <option value="entrada">Entrada</option>
            <option value="saida">Saida</option>
            <option value="ajuste">Ajuste</option>
          </Select>
          <Field label="Quantidade" required type="number" value={movementForm.quantity} onChange={(event) => updateMovementForm('quantity', event.target.value)} />
          <Field label="Custo unitario CVE" type="number" min={0} value={movementForm.unitCostCve} onChange={(event) => updateMovementForm('unitCostCve', event.target.value)} />
          <Field label="Fornecedor" value={movementForm.supplier} onChange={(event) => updateMovementForm('supplier', event.target.value)} />
          <Field label="Referencia" value={movementForm.reference} onChange={(event) => updateMovementForm('reference', event.target.value)} />
          <Field wide label="Notas" value={movementForm.notes} onChange={(event) => updateMovementForm('notes', event.target.value)} />
        </form>
      </Dialog>
    </section>
  );
}

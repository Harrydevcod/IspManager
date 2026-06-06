import { Activity, ArrowDownUp, Banknote, Boxes, Cable, Gauge, HardDrive, Network, Pencil, Radio, Router, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Field, FilterBar, Message, Select, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { formatPtDate } from '../lib/format';
import { stockLevelTone } from '../lib/status';
import type { CatalogAssignments, StockCatalogRow, StockMovement, StockSummary } from '../types';
import './StockModule.css';

type StockFormState = {
  category: 'equipamento' | 'material';
  type: StockCatalogRow['type'];
  brand: string;
  model: string;
  supplier: string;
  unitOfMeasure: string;
  isSerialized: '1' | '0';
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
    category: 'equipamento',
    type: 'router',
    brand: '',
    model: '',
    supplier: '',
    unitOfMeasure: 'un',
    isSerialized: '1',
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

function iconForType(type: StockCatalogRow['type']): LucideIcon {
  switch (type) {
    case 'cpe':    return HardDrive;
    case 'router': return Router;
    case 'antena': return Radio;
    case 'switch': return Network;
    default:       return Boxes;
  }
}

function movementTone(type: StockMovement['type']): 'success' | 'danger' | 'info' {
  if (type === 'entrada') return 'success';
  if (type === 'saida') return 'danger';
  return 'info';
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
  const [stockTab, setStockTab] = useState<'equipamento' | 'material'>('equipamento');
  const [typeFilter, setTypeFilter] = useState<'all' | StockCatalogRow['type']>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [catalogForm, setCatalogForm] = useState<StockFormState>(emptyCatalogForm());
  const [movementForm, setMovementForm] = useState<StockMovementFormState>(emptyMovementForm());

  const loadStock = useCallback(() => {
    return authFetch('http://127.0.0.1:3001/api/stock/summary')
      .then((response) => response.json() as Promise<StockSummary>)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

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
  }, [loadStock]);

  function updateCatalogForm(field: keyof StockFormState, value: string) {
    setCatalogForm((current) => {
      if (field === 'category' && value === 'material') {
        return { ...current, category: 'material', isSerialized: '0', type: current.type === 'outro' ? 'outro' : current.type };
      }
      if (field === 'category' && value === 'equipamento') {
        return { ...current, category: 'equipamento', isSerialized: '1' };
      }
      return { ...current, [field]: value };
    });
  }

  function updateMovementForm(field: keyof StockMovementFormState, value: string) {
    setMovementForm((current) => ({ ...current, [field]: value }));
  }

  function openCreateCatalog() {
    setEditingCatalog(null);
    setCatalogForm(stockTab === 'material'
      ? { ...emptyCatalogForm(), category: 'material', isSerialized: '0', type: 'cabo', unitOfMeasure: 'metro' }
      : emptyCatalogForm());
    setShowCatalogForm(true);
  }

  function editCatalog(catalog: StockCatalogRow) {
    setEditingCatalog(catalog);
    setCatalogForm({
      category: catalog.category,
      type: catalog.type,
      brand: catalog.brand || '',
      model: catalog.model,
      supplier: catalog.supplier || '',
      unitOfMeasure: catalog.unitOfMeasure,
      isSerialized: catalog.isSerialized ? '1' : '0',
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
        isSerialized: catalogForm.isSerialized === '1',
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

  const tabCounts = useMemo(() => {
    const rows = summary?.rows || [];
    return {
      equipamento: rows.filter((item) => item.category === 'equipamento').length,
      material: rows.filter((item) => item.category === 'material').length
    };
  }, [summary]);

  // Cards de resumo específicos da aba ativa (não o total global do catálogo).
  const totals = useMemo(() => {
    if (!summary) return undefined;
    const rows = summary.rows.filter((item) => item.category === stockTab);
    return {
      models: rows.length,
      available: rows.reduce((sum, item) => sum + item.stockTotal, 0),
      lowStock: rows.filter((item) => item.stockTotal > 0 && item.stockTotal <= 3).length,
      inventoryValueCve: rows.reduce((sum, item) => sum + item.landedCostCve * item.stockTotal, 0)
    };
  }, [summary, stockTab]);

  const visibleStockRows = useMemo(() => (summary?.rows || []).filter((item) => {
    const normalizedSearch = search.trim().toLowerCase();
    const label = `${item.brand || ''} ${item.model} ${item.supplier || ''}`.toLowerCase();
    const matchesSearch = !normalizedSearch || label.includes(normalizedSearch);
    const matchesTab = item.category === stockTab;
    const matchesType = typeFilter === 'all' || item.type === typeFilter;
    const matchesStock = stockFilter === 'all'
      || (stockFilter === 'low' && item.stockTotal > 0 && item.stockTotal <= 3)
      || (stockFilter === 'out' && item.stockTotal <= 0);
    return matchesSearch && matchesTab && matchesType && matchesStock;
  }), [summary, search, stockTab, typeFilter, stockFilter]);

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Stock</h2>
          {totals && (
            <p className="stock-header-subtitle">
              <strong>{totals.models}</strong> {stockTab === 'material' ? 'referencias' : 'modelos'} · <strong>{totals.available}</strong> unidades
              {totals.lowStock > 0 && <> · <strong>{totals.lowStock}</strong> em stock baixo</>}
            </p>
          )}
        </div>
        {canManageStock && (
          <Button onClick={openCreateCatalog}>
            {stockTab === 'material' ? 'Novo material' : 'Novo equipamento'}
          </Button>
        )}
      </div>

      <nav className="segmented-tabs" role="tablist" aria-label="Categoria de stock">
        <Button
          variant="ghost"
          role="tab"
          aria-selected={stockTab === 'equipamento'}
          className={`segmented-tab${stockTab === 'equipamento' ? ' is-active' : ''}`}
          onClick={() => { setStockTab('equipamento'); setTypeFilter('all'); }}
        >
          <Boxes size={14} aria-hidden />
          <span>Equipamentos</span>
          <span className="segmented-tab-count">{tabCounts.equipamento}</span>
        </Button>
        <Button
          variant="ghost"
          role="tab"
          aria-selected={stockTab === 'material'}
          className={`segmented-tab${stockTab === 'material' ? ' is-active' : ''}`}
          onClick={() => { setStockTab('material'); setTypeFilter('all'); }}
        >
          <Cable size={14} aria-hidden />
          <span>Materiais</span>
          <span className="segmented-tab-count">{tabCounts.material}</span>
        </Button>
      </nav>

      <div className="stock-filter-sticky">
        <FilterBar>
          <Field type="search" label="Buscar" aria-label="Pesquisar stock" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Marca, modelo ou fornecedor" />
          <Select label="Tipo" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | StockCatalogRow['type'])}>
            <option value="all">Todos</option>
            {stockTab === 'equipamento' ? (
              <>
                <option value="cpe">CPE</option>
                <option value="router">Router</option>
                <option value="antena">Antena</option>
                <option value="switch">Switch</option>
                <option value="outro">Outro</option>
              </>
            ) : (
              <>
                <option value="cabo">Cabo</option>
                <option value="conector">Conector</option>
                <option value="ficha">Ficha</option>
                <option value="suporte">Suporte</option>
                <option value="outro">Outro</option>
              </>
            )}
          </Select>
          <Select label="Stock" value={stockFilter} onChange={(event) => setStockFilter(event.target.value as 'all' | 'low' | 'out')}>
            <option value="all">Todos</option>
            <option value="low">Baixo</option>
            <option value="out">Esgotado</option>
          </Select>
          <Button variant="secondary" onClick={() => { setSearch(''); setTypeFilter('all'); setStockFilter('all'); }}>
            Limpar filtros
          </Button>
          <small>{visibleStockRows.length} {visibleStockRows.length === 1 ? 'modelo' : 'modelos'}</small>
        </FilterBar>
      </div>

      <section className="metric-grid compact" aria-label="Resumo de stock">
        <article className="metric-card">
          <Boxes size={20} />
          <span>{stockTab === 'material' ? 'Referencias' : 'Modelos'}</span>
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
              <p className="eyebrow">{selectedCatalog.category === 'material' ? 'Material selecionado' : 'Equipamento selecionado'}</p>
              <h2>{selectedCatalog.brand ? `${selectedCatalog.brand} ${selectedCatalog.model}` : selectedCatalog.model}</h2>
            </div>
            {canManageStock && (
              <div className="inline-actions">
                <Button variant="secondary" size="sm" onClick={() => editCatalog(selectedCatalog)}>Editar</Button>
                <Button size="sm" onClick={openMovementForm}>Movimento</Button>
              </div>
            )}
          </div>
          {selectedCatalog.category === 'material' ? (
            <dl>
              <div><dt>Tipo</dt><dd>{selectedCatalog.type}</dd></div>
              <div><dt>Stock</dt><dd>{selectedCatalog.stockTotal} {selectedCatalog.unitOfMeasure}</dd></div>
              <div><dt>Custo/{selectedCatalog.unitOfMeasure}</dt><dd>{selectedCatalog.landedCostCve.toLocaleString('pt-PT')} CVE</dd></div>
            </dl>
          ) : (
            <dl>
              <div><dt>Tipo</dt><dd>{selectedCatalog.type}</dd></div>
              <div><dt>Stock</dt><dd>{selectedCatalog.stockTotal}</dd></div>
              <div><dt>Atribuidos</dt><dd>{assignments ? assignments.activeCount : '-'}</dd></div>
              <div><dt>Custo</dt><dd>{selectedCatalog.landedCostCve.toLocaleString('pt-PT')} CVE</dd></div>
              <div><dt>Venda</dt><dd>{selectedCatalog.sellingPriceCve.toLocaleString('pt-PT')} CVE</dd></div>
              <div><dt>Aluguer</dt><dd>{selectedCatalog.rentalFeeCve.toLocaleString('pt-PT')} CVE</dd></div>
            </dl>
          )}

          {selectedCatalog.category !== 'material' && (
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
                        <div><dt>Desde</dt><dd>{formatPtDate(row.startDate)}</dd></div>
                        {row.endDate && (
                          <div><dt>Devolvido</dt><dd>{formatPtDate(row.endDate)}</dd></div>
                        )}
                      </dl>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          )}

          {movements.length > 0 && (
            <div className="stock-movements" aria-label="Ultimos movimentos">
              {movements.slice(0, 8).map((movement) => (
                <div className="stock-movement" key={movement.id}>
                  <span className="stock-movement-type" data-tone={movementTone(movement.type)}>
                    <ArrowDownUp size={11} aria-hidden /> {movement.type}
                  </span>
                  <span className="stock-movement-qty">{movement.quantity}</span>
                  <span className="stock-movement-ref">{movement.reference || movement.notes || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {visibleStockRows.length === 0 && summary && (
        <EmptyState
          icon={stockTab === 'material' ? Cable : Boxes}
          title={stockTab === 'material' ? 'Nenhum material encontrado' : 'Nenhum equipamento encontrado'}
          description={stockTab === 'material'
            ? 'Ajusta os filtros ou cadastra um novo material (cabo, conector…) no catálogo.'
            : 'Ajusta os filtros ou cadastra um novo equipamento no catálogo.'}
        />
      )}

      {visibleStockRows.length > 0 && (
        <div className="stock-list" role="list">
          {visibleStockRows.map((item) => {
            const Icon = iconForType(item.type);
            const tone = stockLevelTone(item.stockTotal);
            const interactive = true;
            const classes = ['stock-item', 'is-interactive'];
            if (selectedCatalog?.id === item.id) classes.push('is-selected');
            return (
              <div
                role="listitem"
                key={item.id}
                className={classes.join(' ')}
                tabIndex={interactive ? 0 : undefined}
                onClick={() => selectCatalog(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectCatalog(item);
                  }
                }}
              >
                <span className="stock-item-icon" aria-hidden>
                  <Icon size={16} strokeWidth={1.6} />
                </span>
                <div className="stock-item-main">
                  <span className="stock-item-name">{item.brand ? `${item.brand} ${item.model}` : item.model}</span>
                  <span className="stock-item-meta">
                    <span>{item.type}</span>
                    <span className="stock-item-meta-sep">·</span>
                    <span className="stock-item-meta-supplier">{item.supplier || 'sem fornecedor'}</span>
                  </span>
                </div>
                <span className="stock-item-level">
                  <span className="stock-item-level-dot" data-tone={tone} aria-hidden />
                  <span className="stock-item-level-value">{item.stockTotal}</span>
                  <span className="stock-item-level-unit">{item.unitOfMeasure || 'un.'}</span>
                </span>
                <div className="stock-item-value">
                  <span className="stock-item-value-amount">{item.sellingPriceCve.toLocaleString('pt-PT')}</span>
                  <span className="stock-item-value-label">CVE venda</span>
                </div>
                {canManageStock && (
                  <div className="stock-item-actions" onClick={(event) => event.stopPropagation()}>
                    <Button
                      variant="icon"
                      size="sm"
                      title="Editar equipamento"
                      aria-label={`Editar ${item.model}`}
                      onClick={(event) => { event.stopPropagation(); editCatalog(item); }}
                    >
                      <Pencil size={14} aria-hidden />
                    </Button>
                    <Button
                      variant="icon"
                      size="sm"
                      title="Novo movimento"
                      aria-label={`Novo movimento ${item.model}`}
                      onClick={(event) => { event.stopPropagation(); selectCatalog(item); openMovementForm(); }}
                    >
                      <ArrowDownUp size={14} aria-hidden />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={showCatalogForm}
        onClose={closeCatalogForm}
        eyebrow={
          catalogForm.category === 'material'
            ? (editingCatalog ? 'Editar material' : 'Novo material')
            : (editingCatalog ? 'Editar equipamento' : 'Novo equipamento')
        }
        title={editingCatalog ? (editingCatalog.brand ? `${editingCatalog.brand} ${editingCatalog.model}` : editingCatalog.model) : (catalogForm.category === 'material' ? 'Material' : 'Equipamento')}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeCatalogForm}>Cancelar</Button>
            <Button type="submit" form="catalog-form">
              {editingCatalog
                ? (catalogForm.category === 'material' ? 'Atualizar material' : 'Atualizar equipamento')
                : (catalogForm.category === 'material' ? 'Gravar material' : 'Gravar equipamento')}
            </Button>
          </>
        }
      >
        <form id="catalog-form" className="client-form" onSubmit={saveCatalog}>
          {catalogForm.category === 'material' ? (
            <>
              <Select label="Tipo" value={catalogForm.type} onChange={(event) => updateCatalogForm('type', event.target.value)}>
                <option value="cabo">Cabo</option>
                <option value="conector">Conector</option>
                <option value="ficha">Ficha</option>
                <option value="suporte">Suporte</option>
                <option value="outro">Outro</option>
              </Select>
              <Field label="Designacao" required value={catalogForm.model} onChange={(event) => updateCatalogForm('model', event.target.value)} placeholder="Ex.: Cabo UTP Cat6" />
              <Select label="Unidade de medida" value={catalogForm.unitOfMeasure} onChange={(event) => updateCatalogForm('unitOfMeasure', event.target.value)}>
                <option value="metro">Metro</option>
                <option value="un">Unidade</option>
                <option value="caixa">Caixa</option>
                <option value="rolo">Rolo</option>
                <option value="par">Par</option>
              </Select>
              <Field label="Fornecedor" value={catalogForm.supplier} onChange={(event) => updateCatalogForm('supplier', event.target.value)} />
              <Field label="Custo por unidade CVE" type="number" min={0} value={catalogForm.purchasePriceCve} onChange={(event) => updateCatalogForm('purchasePriceCve', event.target.value)} />
              <Field label={editingCatalog ? `Stock atual (${catalogForm.unitOfMeasure})` : `Stock inicial (${catalogForm.unitOfMeasure})`} type="number" min={0} value={catalogForm.stockTotal} onChange={(event) => updateCatalogForm('stockTotal', event.target.value)} />
              <Select label="Estado" value={catalogForm.active} onChange={(event) => updateCatalogForm('active', event.target.value)}>
                <option value="1">Ativo</option>
                <option value="0">Inativo</option>
              </Select>
            </>
          ) : (
            <>
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
            </>
          )}
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

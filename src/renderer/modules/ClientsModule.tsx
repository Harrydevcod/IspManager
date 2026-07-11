import { Cable, MessageCircle, Pencil, Upload, UsersRound, Wallet } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, BulkActionBar, Button, DataTable, Dialog, EmptyState, ErrorRetry, Field, FilterBar, Message, PaginationControls, Select, SkeletonList, useConfirm, useToast } from '../components';
import { ClientImportDialog } from './clients/import';
import { authFetch, useAuth } from '../lib/auth';
import { CV_ISLANDS, DEFAULT_ISLAND, isKnownIsland } from '../lib/islands';
import { formatCve, formatPtDate } from '../lib/format';
import { compareText, paginateRows, sortRows, type SortState } from '../lib/listView';
import { runBulk, summarizeBulk } from '../lib/bulkRun';
import { useRowSelection } from '../lib/useRowSelection';
import { statusLabel, statusTone } from '../lib/status';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { Client, ClientProfitability } from '../types';

type ClientFormState = {
  fullName: string;
  phone: string;
  nif: string;
  island: string;
  zone: string;
  address: string;
  status: 'active' | 'suspended' | 'cancelled';
};

type MessagingSettings = { companyName: string; whatsappTemplate: string };
type ClientSortKey = 'fullName' | 'clientCode' | 'status' | 'island' | 'zone';

const DEFAULT_CLIENT_SORT: SortState<ClientSortKey> = { key: 'fullName', direction: 'asc' };
const DEFAULT_CLIENT_PAGE_SIZE = 25;

type ClientNotice = {
  id: number;
  noticeType: 'reminder' | 'overdue' | 'warning' | 'suspension';
  origin: 'auto' | 'manual';
  status: 'sent' | 'failed';
  sentAt: string;
  referenceMonth: string | null;
  invoiceNumber: string | null;
  amountCve: number | null;
};

const NOTICE_LABELS: Record<ClientNotice['noticeType'], string> = {
  reminder: 'Lembrete',
  overdue: 'Vencido',
  warning: 'Aviso',
  suspension: 'Suspensão'
};
const NOTICE_TONES: Record<ClientNotice['noticeType'], 'info' | 'accent' | 'danger'> = {
  reminder: 'info',
  overdue: 'accent',
  warning: 'accent',
  suspension: 'danger'
};

function emptyClientForm(): ClientFormState {
  return { fullName: '', phone: '', nif: '', island: DEFAULT_ISLAND, zone: '', address: '', status: 'active' };
}

// NIF de Cabo Verde: 9 dígitos, o primeiro identifica o tipo de contribuinte
// (1 = pessoa singular, 2 = pessoa coletiva). Mesmo formato validado no backend.
const CV_NIF_RE = /^[12]\d{8}$/;
function cvNifError(nif: string): string | undefined {
  return nif.length > 0 && !CV_NIF_RE.test(nif) ? 'NIF inválido — 9 dígitos a começar por 1 ou 2.' : undefined;
}

export function ClientsModule({
  focusClientId,
  onFocusHandled,
  onOpenServicesForClient
}: {
  focusClientId?: number | null;
  onFocusHandled?: () => void;
  onOpenServicesForClient?: (clientId: number) => void;
} = {}) {
  const { toast } = useToast();
  const auth = useAuth();
  const canManageClients = auth.isAuthBypassed || auth.hasRole('admin', 'operator');
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Client['status']>('all');
  const [messagingSettings, setMessagingSettings] = useState<MessagingSettings>({
    companyName: 'ISPM',
    whatsappTemplate: fallbackWhatsappTemplate
  });
  const [form, setForm] = useState<ClientFormState>(emptyClientForm());
  // Zonas já usadas — datalist contra grafias divergentes ("Palmarejo" vs
  // "palmarejo"), que partem a atribuição de receita/OPEX no Financeiro.
  const zoneOptions = useMemo(() => {
    const set = new Set<string>();
    for (const client of clients) if (client.zone) set.add(client.zone);
    return [...set].sort((a, b) => a.localeCompare(b, 'pt'));
  }, [clients]);
  const [profitability, setProfitability] = useState<ClientProfitability | null>(null);
  const [profitabilityLoading, setProfitabilityLoading] = useState(false);
  const [notices, setNotices] = useState<ClientNotice[]>([]);
  const [sortState, setSortState] = useState<SortState<ClientSortKey>>(DEFAULT_CLIENT_SORT);
  const [clientPage, setClientPage] = useState(1);
  const [clientPageSize, setClientPageSize] = useState(DEFAULT_CLIENT_PAGE_SIZE);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<Client['status']>('suspended');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const selection = useRowSelection<number>();
  const confirm = useConfirm();

  const loadClients = useCallback(() => {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/clients')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar clientes');
        }
        return response.json() as Promise<Client[]>;
      })
      .then((data) => {
        setClients(data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Erro ao carregar clientes';
        setLoadError(message);
        toast(message, 'error');
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    if (!selectedClient) {
      setProfitability(null);
      setNotices([]);
      return;
    }
    let cancelled = false;
    setProfitabilityLoading(true);
    authFetch(`http://127.0.0.1:3001/api/clients/${selectedClient.id}/profitability`)
      .then((response) => response.ok ? response.json() as Promise<ClientProfitability> : null)
      .then((data) => {
        if (!cancelled) setProfitability(data);
      })
      .catch(() => {
        if (!cancelled) setProfitability(null);
      })
      .finally(() => {
        if (!cancelled) setProfitabilityLoading(false);
      });
    authFetch(`http://127.0.0.1:3001/api/clients/${selectedClient.id}/notices`)
      .then((response) => response.ok ? response.json() as Promise<ClientNotice[]> : [])
      .then((data) => {
        if (!cancelled) setNotices(data);
      })
      .catch(() => {
        if (!cancelled) setNotices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClient]);

  useEffect(() => {
    void loadClients();
  }, [loadClients]);

  useEffect(() => {
    if (!focusClientId || loading) return;
    const existing = clients.find((c) => c.id === focusClientId);
    if (existing) {
      setSelectedClient(existing);
    }
    // Clear focus once the list has loaded, whether or not the client was found,
    // so a stale/removed id never leaves focusClientId stuck.
    onFocusHandled?.();
  }, [focusClientId, clients, loading, onFocusHandled]);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/settings')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar configuracoes');
        }
        return response.json() as Promise<MessagingSettings>;
      })
      .then((settings) => {
        setMessagingSettings({
          companyName: settings.companyName || 'ISPM',
          whatsappTemplate: settings.whatsappTemplate || fallbackWhatsappTemplate
        });
      })
      .catch(() => {
        setMessagingSettings({
          companyName: 'ISPM',
          whatsappTemplate: fallbackWhatsappTemplate
        });
      });
  }, []);

  function updateForm(field: keyof ClientFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function openCreate() {
    setSelectedClient(null);
    setEditingClient(null);
    setForm(emptyClientForm());
    setShowCreateForm(true);
  }

  function editClient(client: Client) {
    setEditingClient(client);
    setSelectedClient(null);
    setForm({
      fullName: client.fullName,
      phone: client.phone || '',
      nif: client.nif || '',
      island: client.island || '',
      zone: client.zone || '',
      address: client.address || '',
      status: client.status
    });
    setShowCreateForm(true);
  }

  function closeForm() {
    setEditingClient(null);
    setShowCreateForm(false);
    setForm(emptyClientForm());
  }

  async function sendClientWhatsapp(client: Client) {
    const message = renderWhatsappMessage(messagingSettings.whatsappTemplate, client, messagingSettings.companyName);
    try {
      await sendWhatsappViaUltraMsg(client.phone, message);
      toast('Mensagem WhatsApp enviada via UltraMsg.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Nao foi possivel enviar WhatsApp', 'error');
    }
  }

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    try {
      const response = await authFetch('http://127.0.0.1:3001/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        throw new Error('Nao foi possivel gravar o cliente');
      }

      const client = await response.json() as Client;
      setClients((current) => [...current, client].sort((a, b) => a.fullName.localeCompare(b.fullName)));
      setSelectedClient(client);
      closeForm();
      toast('Cliente criado.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao gravar cliente', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function saveClient(event: FormEvent<HTMLFormElement>) {
    if (!editingClient) {
      await createClient(event);
      return;
    }

    event.preventDefault();
    setSaving(true);

    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/clients/${editingClient.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || 'Nao foi possivel atualizar o cliente');
      }

      const client = await response.json() as Client;
      setClients((current) => current.map((item) => item.id === client.id ? client : item).sort((a, b) => a.fullName.localeCompare(b.fullName)));
      setSelectedClient(client);
      closeForm();
      toast('Cliente atualizado.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao atualizar cliente', 'error');
    } finally {
      setSaving(false);
    }
  }

  const filteredClients = useMemo(() => clients.filter((client) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || client.fullName.toLowerCase().includes(normalizedSearch)
      || client.clientCode.toLowerCase().includes(normalizedSearch)
      || (client.phone || '').toLowerCase().includes(normalizedSearch);
    const matchesStatus = statusFilter === 'all' || client.status === statusFilter;
    return matchesSearch && matchesStatus;
  }), [clients, search, statusFilter]);
  const visibleClients = useMemo(() => sortRows(filteredClients, sortState, {
    fullName: (a, b) => compareText(a.fullName, b.fullName) || compareText(a.clientCode, b.clientCode),
    clientCode: (a, b) => compareText(a.clientCode, b.clientCode),
    status: (a, b) => compareText(a.status, b.status) || compareText(a.fullName, b.fullName),
    island: (a, b) => compareText(a.island, b.island) || compareText(a.fullName, b.fullName),
    zone: (a, b) => compareText(a.zone, b.zone) || compareText(a.fullName, b.fullName)
  }), [filteredClients, sortState]);
  const pagedClients = useMemo(
    () => paginateRows(visibleClients, { page: clientPage, pageSize: clientPageSize }),
    [clientPage, clientPageSize, visibleClients]
  );

  useEffect(() => {
    setClientPage(1);
  }, [search, statusFilter, sortState, clientPageSize]);

  // Seleção em massa restrita ao filtro atual.
  const visibleIds = useMemo(() => visibleClients.map((client) => client.id), [visibleClients]);
  useEffect(() => { selection.retain(visibleIds); }, [visibleIds, selection]);
  const pageIds = useMemo(() => pagedClients.rows.map((client) => client.id), [pagedClients]);
  const tableSelection = {
    isSelected: (key: string | number) => selection.isSelected(Number(key)),
    onToggleRow: (key: string | number) => selection.toggle(Number(key)),
    headerState: selection.visibleState(pageIds),
    onToggleAll: () => selection.toggleVisible(pageIds)
  };

  function selectedClientRows() {
    return visibleClients.filter((client) => selection.isSelected(client.id));
  }

  async function runBulkNotify() {
    const targets = selectedClientRows().filter((client) => normalizeWhatsappPhone(client.phone));
    if (targets.length === 0) {
      toast('Nenhum cliente selecionado com telefone válido.', 'error');
      return;
    }
    if (!(await confirm({
      title: `Notificar ${targets.length} cliente(s) por WhatsApp?`,
      message: 'Envia a mensagem padrão a cada cliente selecionado com telefone válido.',
      confirmLabel: 'Enviar'
    }))) return;
    setBulkSubmitting(true);
    try {
      const result = await runBulk(targets, async (client) => {
        const message = renderWhatsappMessage(messagingSettings.whatsappTemplate, client, messagingSettings.companyName);
        await sendWhatsappViaUltraMsg(client.phone, message);
      });
      toast(summarizeBulk(result, 'notificados'), result.failed ? 'info' : 'success');
      selection.clear();
    } finally {
      setBulkSubmitting(false);
    }
  }

  async function confirmBulkStatus() {
    const targets = selectedClientRows().filter((client) => client.status !== bulkStatus);
    if (targets.length === 0) {
      toast('Nenhum cliente selecionado com estado diferente.', 'error');
      setBulkStatusOpen(false);
      return;
    }
    setBulkSubmitting(true);
    try {
      const result = await runBulk(targets, async (client) => {
        const response = await authFetch(`http://127.0.0.1:3001/api/clients/${client.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: client.fullName,
            phone: client.phone || '',
            nif: client.nif || '',
            island: client.island || '',
            zone: client.zone || '',
            address: client.address || '',
            status: bulkStatus
          })
        });
        if (!response.ok) throw new Error('status update failed');
      });
      toast(summarizeBulk(result, `clientes → ${statusLabel(bulkStatus)}`), result.failed ? 'info' : 'success');
      setBulkStatusOpen(false);
      selection.clear();
      loadClients();
    } finally {
      setBulkSubmitting(false);
    }
  }

  const hasProfitabilityFootprint = profitability
    ? profitability.investments.length > 0 || profitability.equipmentUsed.length > 0 || profitability.installationCostCve > 0
    : false;

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Clientes</h2>
        </div>
        {canManageClients && (
          <div className="inline-actions">
            <Button variant="secondary" size="sm" leadingIcon={<Upload size={14} aria-hidden />} onClick={() => setShowImport(true)}>
              Importar
            </Button>
            <Button size="sm" onClick={openCreate}>
              Novo cliente
            </Button>
          </div>
        )}
      </div>

      <ClientImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onCompleted={() => { void loadClients(); }}
      />

      {loading && <SkeletonList rows={6} />}
      {loadError && !loading && (
        <ErrorRetry message={loadError} onRetry={() => { void loadClients(); }} />
      )}

      <FilterBar>
        <Field type="search" label="Buscar" aria-label="Pesquisar clientes" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, codigo ou telefone" />
        <Select label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | Client['status'])}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="suspended">Suspensos</option>
          <option value="cancelled">Cancelados</option>
        </Select>
        <Button variant="secondary" onClick={() => {
          setSearch('');
          setStatusFilter('all');
          setSortState(DEFAULT_CLIENT_SORT);
          setClientPage(1);
        }}>
          Limpar filtros
        </Button>
        <small>{visibleClients.length} clientes</small>
      </FilterBar>

      {selectedClient && (
        <Dialog
          open
          size="xl"
          eyebrow={selectedClient.clientCode}
          title={selectedClient.fullName}
          onClose={() => setSelectedClient(null)}
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={!normalizeWhatsappPhone(selectedClient.phone)}
                leadingIcon={<MessageCircle size={16} aria-hidden />}
                onClick={() => void sendClientWhatsapp(selectedClient)}
              >
                WhatsApp
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Cable size={16} aria-hidden />}
                onClick={() => onOpenServicesForClient?.(selectedClient.id)}
              >
                Instalar equipamento
              </Button>
              {canManageClients && (
                <Button variant="secondary" size="sm" leadingIcon={<Pencil size={16} aria-hidden />} onClick={() => editClient(selectedClient)}>
                  Editar
                </Button>
              )}
            </>
          }
        >
          <div className="client-detail">
          <dl>
            <div><dt>Telefone</dt><dd>{selectedClient.phone || 'Sem telefone'}</dd></div>
            <div><dt>Ilha</dt><dd>{selectedClient.island || '-'}</dd></div>
            <div><dt>Zona</dt><dd>{selectedClient.zone || '-'}</dd></div>
            <div><dt>Morada</dt><dd>{selectedClient.address || '-'}</dd></div>
            <div><dt>Estado</dt><dd><Badge tone={statusTone(selectedClient.status)}>{statusLabel(selectedClient.status)}</Badge></dd></div>
          </dl>

          <section className="client-profitability">
            <header>
              <strong>Rentabilidade</strong>
              {profitability && hasProfitabilityFootprint && (
                <Badge tone={profitability.isRecovered ? 'success' : profitability.netProfitCve < 0 ? 'danger' : 'info'}>
                  {profitability.isRecovered ? 'Recuperado' : profitability.netProfitCve < 0 ? 'Em prejuizo' : 'Em retorno'}
                </Badge>
              )}
            </header>

            {profitabilityLoading && <Message>A calcular rentabilidade...</Message>}

            {!profitabilityLoading && profitability && !hasProfitabilityFootprint && (
              <EmptyState
                size="sm"
                icon={Wallet}
                title="Sem custos de instalacao"
                description="Instala equipamentos no servico ou adiciona investimentos para calcular a rentabilidade."
              />
            )}

            {!profitabilityLoading && profitability && hasProfitabilityFootprint && (
              <>
                <dl className="client-profitability-grid">
                  <div className="client-profitability-total">
                    <dt>Faturamento total</dt>
                    <dd>{formatCve(profitability.paidRevenueCve + profitability.pendingRevenueCve)}</dd>
                    <small>pago + pendente</small>
                  </div>
                  <div>
                    <dt>Custo de instalacao</dt>
                    <dd>{formatCve(profitability.installationCostCve)}</dd>
                  </div>
                  <div>
                    <dt>Receita paga</dt>
                    <dd>{formatCve(profitability.paidRevenueCve)}</dd>
                  </div>
                  <div>
                    <dt>Receita pendente</dt>
                    <dd>{formatCve(profitability.pendingRevenueCve)}</dd>
                  </div>
                  <div>
                    <dt>Lucro acumulado</dt>
                    <dd className={profitability.netProfitCve < 0 ? 'profit-negative' : 'profit-positive'}>
                      {formatCve(profitability.netProfitCve)}
                    </dd>
                  </div>
                  <div>
                    <dt>Lucro mensal</dt>
                    <dd className={profitability.monthlyNetProfitCve < 0 ? 'profit-negative' : 'profit-positive'}>
                      {formatCve(profitability.monthlyNetProfitCve)}
                    </dd>
                    <small>
                      receita media {formatCve(profitability.monthlyAverageRevenueCve)} - OPEX rateio {formatCve(profitability.imputedMonthlyOpexCve)}
                    </small>
                  </div>
                  <div>
                    <dt>Meses ate recuperar</dt>
                    <dd>
                      {profitability.monthsToBreakeven === null
                        ? '-'
                        : profitability.monthsToBreakeven < 1
                          ? '< 1 mes'
                          : `${profitability.monthsToBreakeven.toFixed(profitability.monthsToBreakeven >= 10 ? 0 : 1)} meses`}
                    </dd>
                    {profitability.projectedBreakevenDate && !profitability.isRecovered && (
                      <small>previsao: {formatPtDate(profitability.projectedBreakevenDate)}</small>
                    )}
                  </div>
                  <div>
                    <dt>Rentabilidade</dt>
                    <dd className={(profitability.profitabilityPct ?? 0) < 0 ? 'profit-negative' : 'profit-positive'}>
                      {profitability.profitabilityPct === null ? '-' : `${profitability.profitabilityPct.toFixed(1)}%`}
                    </dd>
                  </div>
                </dl>

                {profitability.equipmentUsed.length > 0 && (
                  <div className="client-profitability-equipment">
                    <strong>Equipamentos usados</strong>
                    <ul>
                      {profitability.equipmentUsed.map((eq) => (
                        <li key={`${eq.itemType}-${eq.itemName}`}>
                          <span>{eq.itemName}</span>
                          <small>{eq.quantityUsed} de {eq.quantity} · {formatCve(eq.totalCostCve)}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>

          {notices.length > 0 && (
            <section className="client-dunning">
              <header><strong>Cobrança</strong><small>{notices.length} aviso(s)</small></header>
              <ul className="client-dunning-timeline">
                {notices.map((n) => (
                  <li key={n.id}>
                    <Badge tone={NOTICE_TONES[n.noticeType]}>{NOTICE_LABELS[n.noticeType]}</Badge>
                    <span>
                      <strong>{n.invoiceNumber || n.referenceMonth || '-'}</strong>
                      <small>
                        {formatPtDate(n.sentAt)} · {n.origin === 'auto' ? 'automático' : 'manual'}
                        {n.amountCve != null && ` · ${formatCve(n.amountCve)}`}
                        {n.status === 'failed' && ' · falhou'}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          </div>
        </Dialog>
      )}

      {!loading && !loadError && (
        <>
          {canManageClients && (
            <BulkActionBar count={selection.count} onClear={selection.clear} noun={{ one: 'cliente selecionado', many: 'clientes selecionados' }}>
              <Button variant="secondary" size="sm" leadingIcon={<MessageCircle size={14} aria-hidden />} disabled={bulkSubmitting} onClick={() => void runBulkNotify()}>
                Notificar WhatsApp
              </Button>
              <Button variant="secondary" size="sm" disabled={bulkSubmitting} onClick={() => setBulkStatusOpen(true)}>
                Mudar estado
              </Button>
            </BulkActionBar>
          )}
          <DataTable
            className="clients-table"
            rows={pagedClients.rows}
            rowKey={(client) => client.id}
            selection={canManageClients ? tableSelection : undefined}
            stickyHeader
            sort={sortState}
            onSortChange={setSortState}
            onRowClick={setSelectedClient}
            gridTemplateColumns="minmax(240px, 1.5fr) 136px 136px 126px"
            actionsWidth="92px"
            columns={[
              {
                header: 'Cliente',
                sortKey: 'fullName',
                cell: (client) => (
                  <span>
                    <small className="entity-code">{client.clientCode}</small>
                    <strong>{client.fullName}</strong>
                    <small>{client.phone || 'sem telefone'}</small>
                  </span>
                )
              },
              {
                header: 'Ilha',
                sortKey: 'island',
                cell: (client) => <span>{client.island || '-'}</span>
              },
              {
                header: 'Zona',
                sortKey: 'zone',
                cell: (client) => <span>{client.zone || '-'}</span>
              },
              {
                header: 'Estado',
                sortKey: 'status',
                align: 'center',
                cell: (client) => <Badge tone={statusTone(client.status)}>{statusLabel(client.status)}</Badge>
              }
            ]}
            actions={(client) => {
              const canWhatsapp = !!normalizeWhatsappPhone(client.phone);
              return (
                <>
                  {canManageClients && (
                    <Button
                      variant="icon"
                      size="sm"
                      className="row-action"
                      title="Editar cliente"
                      aria-label="Editar cliente"
                      onClick={() => editClient(client)}
                    >
                      <Pencil size={14} aria-hidden />
                    </Button>
                  )}
                  <Button
                    variant="icon"
                    size="sm"
                    className="row-action"
                    title={canWhatsapp ? 'Enviar WhatsApp' : 'Sem telefone valido'}
                    aria-label="Enviar WhatsApp"
                    disabled={!canWhatsapp}
                    onClick={() => void sendClientWhatsapp(client)}
                  >
                    <MessageCircle size={14} aria-hidden />
                  </Button>
                </>
              );
            }}
            empty={
              <EmptyState
                icon={UsersRound}
                title="Nenhum cliente encontrado"
                description="Ajusta os filtros ou regista um novo cliente."
              />
            }
          />
          <PaginationControls
            page={pagedClients.page}
            pageSize={pagedClients.pageSize}
            total={pagedClients.total}
            totalPages={pagedClients.totalPages}
            start={pagedClients.start}
            end={pagedClients.end}
            onPageChange={setClientPage}
            onPageSizeChange={setClientPageSize}
          />
        </>
      )}

      <Dialog
        open={showCreateForm}
        onClose={closeForm}
        eyebrow={editingClient ? 'Editar cliente' : 'Novo cliente'}
        title={editingClient ? editingClient.fullName : 'Cliente'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" form="client-form" loading={saving} disabled={cvNifError(form.nif) !== undefined}>
              {saving ? 'A gravar...' : editingClient ? 'Atualizar cliente' : 'Gravar cliente'}
            </Button>
          </>
        }
      >
        <form id="client-form" className="client-form" onSubmit={saveClient}>
          <Field label="Nome completo" required value={form.fullName} onChange={(event) => updateForm('fullName', event.target.value)} />
          <Field label="Telefone" type="tel" inputMode="tel" value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} />
          <Field label="NIF" inputMode="numeric" maxLength={9} value={form.nif} onChange={(event) => updateForm('nif', event.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="9 dígitos (começa por 1 ou 2)" hint="1 = pessoa singular · 2 = pessoa coletiva" error={cvNifError(form.nif)} />
          <Select label="Ilha" value={form.island} onChange={(event) => updateForm('island', event.target.value)}>
            <option value="">—</option>
            {CV_ISLANDS.map((island) => (
              <option key={island} value={island}>{island}</option>
            ))}
            {form.island !== '' && !isKnownIsland(form.island) && (
              <option value={form.island}>{form.island} (grafia antiga)</option>
            )}
          </Select>
          <Field label="Zona" list="client-zones" value={form.zone} onChange={(event) => updateForm('zone', event.target.value)} />
          <datalist id="client-zones">
            {zoneOptions.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          <Field wide label="Morada" value={form.address} onChange={(event) => updateForm('address', event.target.value)} />
          <Select label="Estado" value={form.status} onChange={(event) => updateForm('status', event.target.value)}>
            <option value="active">Ativo</option>
            <option value="suspended">Suspenso</option>
            <option value="cancelled">Cancelado</option>
          </Select>
        </form>
      </Dialog>

      <Dialog
        open={bulkStatusOpen}
        onClose={() => { if (!bulkSubmitting) setBulkStatusOpen(false); }}
        eyebrow="Ações em massa"
        title={`Mudar estado · ${selection.count} cliente(s)`}
        size="sm"
        actions={
          <>
            <Button variant="secondary" onClick={() => setBulkStatusOpen(false)} disabled={bulkSubmitting}>Cancelar</Button>
            <Button
              variant={bulkStatus === 'cancelled' ? 'danger' : 'primary'}
              loading={bulkSubmitting}
              onClick={() => void confirmBulkStatus()}
            >
              Aplicar estado
            </Button>
          </>
        }
      >
        <div className="overdue-notify">
          {bulkStatus === 'cancelled' && (
            <Message tone="error">
              Cancelar clientes propaga o cancelamento aos respetivos serviços. Esta ação afeta a faturação.
            </Message>
          )}
          <Select label="Novo estado" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as Client['status'])} disabled={bulkSubmitting}>
            <option value="active">Ativo</option>
            <option value="suspended">Suspenso</option>
            <option value="cancelled">Cancelado</option>
          </Select>
        </div>
      </Dialog>
    </section>
  );
}

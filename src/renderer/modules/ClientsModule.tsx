import { MessageCircle, Pencil, Upload, UsersRound, Wallet } from 'lucide-react';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, DetailPanel, Dialog, EmptyState, Field, FilterBar, Message, Select, useToast } from '../components';
import { ClientImportDialog } from './clients/import';
import { authFetch, useAuth } from '../lib/auth';
import { formatCve } from '../lib/format';
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

function emptyClientForm(): ClientFormState {
  return { fullName: '', phone: '', nif: '', island: '', zone: '', address: '', status: 'active' };
}

export function ClientsModule({ focusClientId, onFocusHandled }: { focusClientId?: number | null; onFocusHandled?: () => void } = {}) {
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
  const [profitability, setProfitability] = useState<ClientProfitability | null>(null);
  const [profitabilityLoading, setProfitabilityLoading] = useState(false);

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

  const visibleClients = clients.filter((client) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch = !normalizedSearch
      || client.fullName.toLowerCase().includes(normalizedSearch)
      || client.clientCode.toLowerCase().includes(normalizedSearch)
      || (client.phone || '').toLowerCase().includes(normalizedSearch);
    const matchesStatus = statusFilter === 'all' || client.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

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

      {loading && <Message>A carregar clientes...</Message>}
      {loadError && !loading && (
        <Message tone="error">{loadError}</Message>
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
        }}>
          Limpar filtros
        </Button>
        <small>{visibleClients.length} clientes</small>
      </FilterBar>

      {selectedClient && (
        <DetailPanel
          eyebrow={selectedClient.clientCode}
          title={selectedClient.fullName}
          actionsClassName="client-preview-actions"
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
              {canManageClients && (
                <Button variant="secondary" size="sm" leadingIcon={<Pencil size={16} aria-hidden />} onClick={() => editClient(selectedClient)}>
                  Editar
                </Button>
              )}
            </>
          }
        >
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
              {profitability && profitability.investments.length > 0 && (
                <Badge tone={profitability.isRecovered ? 'success' : profitability.netProfitCve < 0 ? 'danger' : 'info'}>
                  {profitability.isRecovered ? 'Recuperado' : profitability.netProfitCve < 0 ? 'Em prejuizo' : 'Em retorno'}
                </Badge>
              )}
            </header>

            {profitabilityLoading && <Message>A calcular rentabilidade...</Message>}

            {!profitabilityLoading && profitability && profitability.investments.length === 0 && (
              <EmptyState
                size="sm"
                icon={Wallet}
                title="Sem investimentos registados"
                description="Este cliente ainda não tem investimentos lançados. Adiciona no módulo Investimentos."
              />
            )}

            {!profitabilityLoading && profitability && profitability.investments.length > 0 && (
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
                      <small>previsao: {profitability.projectedBreakevenDate}</small>
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
        </DetailPanel>
      )}

      {!loading && !loadError && (
        <div className="module-table">
          {visibleClients.map((client) => {
            const canWhatsapp = !!normalizeWhatsappPhone(client.phone);
            return (
              <div
                className="module-row client-row interactive"
                key={client.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedClient(client)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedClient(client);
                  }
                }}
              >
                <span>
                  <small className="entity-code">{client.clientCode}</small>
                  <strong>{client.fullName}</strong>
                  <small>{client.phone || 'sem telefone'}</small>
                </span>
                <Badge tone={statusTone(client.status)}>{statusLabel(client.status)}</Badge>
                <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                  {canManageClients && (
                    <Button
                      variant="icon"
                      size="sm"
                      className="row-action"
                      title="Editar cliente"
                      aria-label="Editar cliente"
                      onClick={(event) => {
                        event.stopPropagation();
                        editClient(client);
                      }}
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
                    onClick={(event) => {
                      event.stopPropagation();
                      void sendClientWhatsapp(client);
                    }}
                  >
                    <MessageCircle size={14} aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}
          {visibleClients.length === 0 && (
            <EmptyState
              icon={UsersRound}
              title="Nenhum cliente encontrado"
              description="Ajusta os filtros ou regista um novo cliente."
            />
          )}
        </div>
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
            <Button type="submit" form="client-form" loading={saving}>
              {saving ? 'A gravar...' : editingClient ? 'Atualizar cliente' : 'Gravar cliente'}
            </Button>
          </>
        }
      >
        <form id="client-form" className="client-form" onSubmit={saveClient}>
          <Field label="Nome completo" required value={form.fullName} onChange={(event) => updateForm('fullName', event.target.value)} />
          <Field label="Telefone" type="tel" inputMode="tel" value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} />
          <Field label="NIF" inputMode="numeric" maxLength={9} value={form.nif} onChange={(event) => updateForm('nif', event.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="9 dígitos" />
          <Field label="Ilha" value={form.island} onChange={(event) => updateForm('island', event.target.value)} />
          <Field label="Zona" value={form.zone} onChange={(event) => updateForm('zone', event.target.value)} />
          <Field wide label="Morada" value={form.address} onChange={(event) => updateForm('address', event.target.value)} />
          <Select label="Estado" value={form.status} onChange={(event) => updateForm('status', event.target.value)}>
            <option value="active">Ativo</option>
            <option value="suspended">Suspenso</option>
            <option value="cancelled">Cancelado</option>
          </Select>
        </form>
      </Dialog>
    </section>
  );
}

import { MessageCircle, Pencil, Upload } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Badge, ClientImportDialog, Dialog, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import { statusLabel, statusTone } from '../lib/status';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { Client } from '../types';

type ClientFormState = {
  fullName: string;
  phone: string;
  island: string;
  zone: string;
  address: string;
  status: 'active' | 'suspended' | 'cancelled';
};

type MessagingSettings = { companyName: string; whatsappTemplate: string };

function emptyClientForm(): ClientFormState {
  return { fullName: '', phone: '', island: '', zone: '', address: '', status: 'active' };
}

export function ClientsModule() {
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

  function loadClients() {
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
  }

  useEffect(() => {
    void loadClients();
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
            <button type="button" onClick={() => setShowImport(true)}>
              <Upload size={14} aria-hidden /> Importar
            </button>
            <button type="button" className="primary" onClick={openCreate}>
              Novo cliente
            </button>
          </div>
        )}
      </div>

      <ClientImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onCompleted={() => { void loadClients(); }}
      />

      {loading && <p className="module-message">A carregar clientes...</p>}
      {loadError && !loading && (
        <p className="module-message error">{loadError}</p>
      )}

      <div className="filter-bar">
        <label>
          Buscar
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, codigo ou telefone" />
        </label>
        <label>
          Estado
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | Client['status'])}>
            <option value="all">Todos</option>
            <option value="active">Ativos</option>
            <option value="suspended">Suspensos</option>
            <option value="cancelled">Cancelados</option>
          </select>
        </label>
        <button type="button" onClick={() => {
          setSearch('');
          setStatusFilter('all');
        }}>
          Limpar filtros
        </button>
        <small>{visibleClients.length} clientes</small>
      </div>

      {selectedClient && (
        <div className="client-detail">
          <div>
            <p className="eyebrow">Cliente selecionado</p>
            <h2>{selectedClient.fullName}</h2>
          </div>
          <dl>
            <div><dt>Codigo</dt><dd>{selectedClient.clientCode}</dd></div>
            <div><dt>Telefone</dt><dd>{selectedClient.phone || 'Sem telefone'}</dd></div>
            <div><dt>Ilha</dt><dd>{selectedClient.island || '-'}</dd></div>
            <div><dt>Zona</dt><dd>{selectedClient.zone || '-'}</dd></div>
            <div><dt>Estado</dt><dd>{selectedClient.status}</dd></div>
          </dl>
          <div className="form-actions detail-actions">
            <button type="button" onClick={() => setSelectedClient(null)}>Fechar detalhe</button>
            <button type="button" disabled={!normalizeWhatsappPhone(selectedClient.phone)} onClick={() => void sendClientWhatsapp(selectedClient)}>
              <MessageCircle size={16} />
              WhatsApp
            </button>
            {canManageClients && <button type="button" onClick={() => editClient(selectedClient)}>Editar cliente</button>}
          </div>
        </div>
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
                  <strong>{client.fullName}</strong>
                  <small>{client.clientCode} - {client.phone || 'sem telefone'}</small>
                </span>
                <Badge tone={statusTone(client.status)}>{statusLabel(client.status)}</Badge>
                <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                  {canManageClients && (
                    <button
                      type="button"
                      className="row-action"
                      title="Editar cliente"
                      aria-label="Editar cliente"
                      onClick={(event) => {
                        event.stopPropagation();
                        editClient(client);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="row-action"
                    title={canWhatsapp ? 'Enviar WhatsApp' : 'Sem telefone valido'}
                    aria-label="Enviar WhatsApp"
                    disabled={!canWhatsapp}
                    onClick={(event) => {
                      event.stopPropagation();
                      void sendClientWhatsapp(client);
                    }}
                  >
                    <MessageCircle size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          {visibleClients.length === 0 && (
            <p className="module-message">Nenhum cliente encontrado para os filtros atuais.</p>
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
            <button type="button" onClick={closeForm}>Cancelar</button>
            <button type="submit" form="client-form" className="primary" disabled={saving}>
              {saving ? 'A gravar...' : editingClient ? 'Atualizar cliente' : 'Gravar cliente'}
            </button>
          </>
        }
      >
        <form id="client-form" className="client-form" onSubmit={saveClient}>
          <label>
            Nome completo
            <input
              required
              value={form.fullName}
              onChange={(event) => updateForm('fullName', event.target.value)}
            />
          </label>
          <label>
            Telefone
            <input value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} />
          </label>
          <label>
            Ilha
            <input value={form.island} onChange={(event) => updateForm('island', event.target.value)} />
          </label>
          <label>
            Zona
            <input value={form.zone} onChange={(event) => updateForm('zone', event.target.value)} />
          </label>
          <label className="wide-field">
            Morada
            <input value={form.address} onChange={(event) => updateForm('address', event.target.value)} />
          </label>
          <label>
            Estado
            <select value={form.status} onChange={(event) => updateForm('status', event.target.value)}>
              <option value="active">Ativo</option>
              <option value="suspended">Suspenso</option>
              <option value="cancelled">Cancelado</option>
            </select>
          </label>
        </form>
      </Dialog>
    </section>
  );
}

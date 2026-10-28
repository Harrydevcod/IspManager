import { useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, Tv } from 'lucide-react';
import { Badge, Button, DataTable, Dialog, EmptyState, Field, Message, Textarea, Toggle, useToast, type DataTableColumn } from '../../components';
import { IPTV_API, iptvRequest, type IptvProvider } from '../iptv/iptv-api';

type ProviderForm = { name: string; hosts: string; notes: string; active: boolean };

const providerForm = (row: IptvProvider | null): ProviderForm => ({
  name: row?.name ?? '',
  hosts: row?.hosts ?? '',
  notes: row?.notes ?? '',
  active: row ? row.active === 1 : true
});

const hostCount = (hosts: string) => hosts.split(/\r?\n/).filter((line) => line.trim()).length;

function ProviderDialog({ provider, open, onClose, onSaved }: {
  provider: IptvProvider | null;
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<ProviderForm>(() => providerForm(provider));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) { setForm(providerForm(provider)); setError(null); }
  }, [open, provider]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const body = { name: form.name.trim(), hosts: form.hosts, notes: form.notes.trim() || null, active: form.active };
    try {
      await iptvRequest(provider ? `${IPTV_API}/providers/${provider.id}` : `${IPTV_API}/providers`, { method: provider ? 'PUT' : 'POST', body });
      onSaved(provider ? 'Fornecedor atualizado.' : 'Fornecedor criado.');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow={provider ? 'Editar fornecedor' : 'Novo fornecedor'}
      title={provider ? provider.name : 'Fornecedor de IPTV'}
      size="md"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="iptv-provider-form" disabled={submitting}>{provider ? 'Atualizar' : 'Criar'}</Button>
        </>
      }
    >
      <form id="iptv-provider-form" className="client-form" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}
        <Field label="Nome" required maxLength={80} value={form.name} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))} />
        <Textarea
          label="Servidores"
          rows={5}
          value={form.hosts}
          placeholder={'portal.exemplo.tv\n203.0.113.10'}
          hint="Um domínio, IP ou gama por linha. Vão para a lista de servidores do router com o comentário do ISPM."
          onChange={(event) => setForm((f) => ({ ...f, hosts: event.target.value }))}
        />
        <Field label="Notas" maxLength={500} value={form.notes} onChange={(event) => setForm((f) => ({ ...f, notes: event.target.value }))} />
        {provider && (
          <Toggle
            title="Fornecedor ativo"
            description="Desativado, os servidores saem da lista do router; os serviços que o têm ficam como estão."
            checked={form.active}
            onChange={(event) => setForm((f) => ({ ...f, active: event.target.checked }))}
          />
        )}
      </form>
    </Dialog>
  );
}

/** Os fornecedores de IPTV e os servidores que o ISPM mantém na lista do router. Não se apagam: desativam-se. */
export function IptvProviders({ providers, canEdit, onChanged }: { providers: IptvProvider[]; canEdit: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<IptvProvider | null>(null);
  const [open, setOpen] = useState(false);

  const columns: DataTableColumn<IptvProvider>[] = [
    { header: 'Nome', cell: (row) => <strong>{row.name}</strong>, sortValue: (row) => row.name },
    { header: 'Servidores', cell: (row) => hostCount(row.hosts), align: 'end', sortValue: (row) => hostCount(row.hosts) },
    { header: 'Estado', sortValue: (row) => row.active === 1 ? 'Ativo' : 'Desativado', cell: (row) => <Badge tone={row.active === 1 ? 'success' : 'neutral'}>{row.active === 1 ? 'Ativo' : 'Desativado'}</Badge> },
    { header: 'Notas', sortValue: (row) => row.notes ?? '', cell: (row) => row.notes || <span className="router-muted">—</span> }
  ];

  return (
    <section className="router-findings" aria-label="Fornecedores de IPTV">
      <div className="iptv-panel-head">
        <h3><Tv size={16} aria-hidden /> Fornecedores de IPTV</h3>
        {canEdit && (
          <Button variant="secondary" size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={() => { setEditing(null); setOpen(true); }}>
            Novo fornecedor
          </Button>
        )}
      </div>
      <DataTable
        rows={providers}
        rowKey={(row) => row.id}
        columns={columns}
        gridTemplateColumns="minmax(10rem, 1.2fr) 7rem 8rem minmax(10rem, 2fr)"
        actions={canEdit ? (row) => (
          <Button variant="ghost" size="sm" aria-label={`Editar ${row.name}`} leadingIcon={<Pencil size={14} aria-hidden />} onClick={() => { setEditing(row); setOpen(true); }}>
            Editar
          </Button>
        ) : undefined}
        empty={<EmptyState size="sm" icon={Tv} title="Sem fornecedores" description="Registe um fornecedor para o ISPM manter os servidores dele na lista do router." />}
      />
      <ProviderDialog
        provider={editing}
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(message) => { setOpen(false); toast(message, 'success'); onChanged(); }}
      />
    </section>
  );
}

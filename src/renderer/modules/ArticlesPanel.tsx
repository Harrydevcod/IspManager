import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Pencil, Tags } from 'lucide-react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, Field, FilterBar, Select, Textarea, useToast } from '../components';
import type { DataTableColumn } from '../components/DataTable';
import { authFetch } from '../lib/auth';
import { formatCve } from '../lib/format';
import { sortByColumns, type SortState } from '../lib/listView';
import type { ArticleRow } from '../types';

const API = 'http://127.0.0.1:3001/api/articles';
const KIND_LABEL: Record<ArticleRow['kind'], string> = { product: 'Produto', service: 'Serviço' };

type ArticleForm = { code: string; name: string; kind: ArticleRow['kind']; unitPriceCve: string; documentNote: string; active: '1' | '0' };
const emptyForm = (): ArticleForm => ({ code: '', name: '', kind: 'service', unitPriceCve: '', documentNote: '', active: '1' });

const COLUMNS: DataTableColumn<ArticleRow>[] = [
  { header: 'Código', sortValue: (row) => row.code, cell: (row) => <span className="entity-code">{row.code}</span> },
  { header: 'Nome', sortValue: (row) => row.name, cell: (row) => <span><strong>{row.name}</strong></span> },
  { header: 'Tipo', sortValue: (row) => KIND_LABEL[row.kind], cell: (row) => <span>{KIND_LABEL[row.kind]}</span> },
  { header: 'Preço', align: 'end', sortValue: (row) => row.unitPriceCve, cell: (row) => <span>{formatCve(row.unitPriceCve)}</span> },
  { header: 'Estado', align: 'center', sortValue: (row) => Number(row.active), cell: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativo' : 'Inativo'}</Badge> }
];
const DEFAULT_SORT: SortState<string> = { key: 'Código', direction: 'asc' };

/**
 * Artigos e serviços sem stock: o que se vende em talões e faturas manuais.
 * As linhas livres desses documentos criam-nos sozinhas; aqui corrige-se código, nome e preço.
 */
/** `createRequest` muda quando o botão "Novo artigo" do cabeçalho do Stock é carregado. */
export function ArticlesPanel({ canManage, createRequest }: { canManage: boolean; createRequest: number }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<ArticleRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | ArticleRow['kind']>('all');
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [editing, setEditing] = useState<ArticleRow | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ArticleForm>(emptyForm());
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => authFetch(API)
    .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<ArticleRow[]>; })
    .then((data) => { setRows(data); setLoadError(false); })
    .catch(() => setLoadError(true)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (createRequest > 0) edit(null); }, [createRequest]);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt');
    const filtered = (rows || []).filter((row) => (kind === 'all' || row.kind === kind)
      && (!term || `${row.code} ${row.name}`.toLocaleLowerCase('pt').includes(term)));
    return sortByColumns(filtered, sort, COLUMNS, DEFAULT_SORT.key);
  }, [rows, search, kind, sort]);

  function edit(row: ArticleRow | null) {
    setEditing(row);
    setForm(row ? { code: row.code, name: row.name, kind: row.kind, unitPriceCve: String(row.unitPriceCve), documentNote: row.documentNote ?? '', active: row.active ? '1' : '0' } : emptyForm());
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await authFetch(editing ? `${API}/${editing.id}` : API, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, unitPriceCve: Number(form.unitPriceCve || 0), active: form.active === '1' })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        toast(result.error || `Não foi possível gravar o artigo (HTTP ${response.status}).`, 'error');
        return;
      }
      toast(editing ? 'Artigo atualizado.' : 'Artigo criado.', 'success');
      setOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {loadError && !rows && <ErrorRetry message="Não foi possível carregar os artigos." onRetry={() => { void load(); }} />}
      <div className="stock-filter-sticky">
        <FilterBar>
          <Field type="search" label="Buscar" aria-label="Pesquisar artigos" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Código ou nome" />
          <Select label="Tipo" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="all">Todos</option>
            <option value="product">Produtos</option>
            <option value="service">Serviços</option>
          </Select>
          <small>{visible.length} {visible.length === 1 ? 'artigo' : 'artigos'}</small>
        </FilterBar>
      </div>
      {rows && (
        <DataTable
          rows={visible}
          rowKey={(row) => row.id}
          stickyHeader
          sort={sort}
          onSortChange={setSort}
          gridTemplateColumns="104px minmax(240px, 1.6fr) 112px 132px 104px"
          actionsWidth="56px"
          columns={COLUMNS}
          actions={canManage ? (row) => (
            <Button variant="icon" size="sm" title="Editar artigo" aria-label={`Editar ${row.name}`} onClick={() => edit(row)}>
              <Pencil size={14} aria-hidden />
            </Button>
          ) : undefined}
          empty={<EmptyState icon={Tags} title="Ainda não há artigos" description="As linhas livres dos talões e das faturas manuais aparecem aqui com código. Também pode criar um à mão." />}
        />
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={editing ? 'Editar artigo' : 'Novo artigo'}
        title={editing ? `${editing.code} · ${editing.name}` : 'Artigo ou serviço'}
        size="md"
        actions={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button type="submit" form="article-form" loading={saving}>{editing ? 'Atualizar artigo' : 'Gravar artigo'}</Button>
        </>}
      >
        <form id="article-form" className="client-form" onSubmit={save}>
          <Field label="Código" maxLength={20} placeholder={editing ? '' : 'Automático'} value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })} />
          <Select label="Tipo" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ArticleRow['kind'] })}>
            <option value="service">Serviço</option>
            <option value="product">Produto</option>
          </Select>
          <Field label="Nome" required maxLength={200} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <Field label="Preço CVE" type="number" min={0} step="0.01" value={form.unitPriceCve} onChange={(event) => setForm({ ...form, unitPriceCve: event.target.value })} />
          <Select label="Estado" value={form.active} onChange={(event) => setForm({ ...form, active: event.target.value as '1' | '0' })}>
            <option value="1">Ativo</option>
            <option value="0">Inativo</option>
          </Select>
          <Textarea label="Nota no documento" rows={2} maxLength={300} value={form.documentNote}
            placeholder="Garantia 12 meses · Recondicionado"
            hint="Garantia, estado do produto… Aparece nas observações dos documentos que o incluem."
            onChange={(event) => setForm({ ...form, documentNote: event.target.value })} />
        </form>
      </Dialog>
    </>
  );
}

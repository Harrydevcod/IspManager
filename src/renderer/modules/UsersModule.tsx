import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserCog, UsersRound, Wrench } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState, Field, FilterBar, Select, SkeletonList, useConfirm, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import type { UserRole } from '../lib/auth';
import './UsersModule.css';

type UserRow = {
  id: number;
  username: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operadora',
  technician: 'Tecnico'
};

const ROLE_ICON: Record<UserRole, ReactNode> = {
  admin: <ShieldCheck size={11} aria-hidden />,
  operator: <UserCog size={11} aria-hidden />,
  technician: <Wrench size={11} aria-hidden />
};

type FormState = {
  username: string;
  fullName: string;
  role: UserRole;
  password: string;
  active: boolean;
};

function emptyForm(): FormState {
  return { username: '', fullName: '', role: 'operator', password: '', active: true };
}

export function UsersModule() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const auth = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | UserRole>('all');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const load = useCallback(() => {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/users')
      .then((res) => {
        if (!res.ok) throw new Error('load failed');
        return res.json() as Promise<UserRow[]>;
      })
      .then(setUsers)
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setShowForm(true);
  }

  function openEdit(row: UserRow) {
    setEditing(row);
    setForm({
      username: row.username,
      fullName: row.fullName,
      role: row.role,
      password: '',
      active: row.active
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  function openReset(row: UserRow) {
    setResetting(row);
    setResetPassword('');
  }

  function closeReset() {
    setResetting(null);
    setResetPassword('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (editing) {
        const payload: Record<string, unknown> = {
          fullName: form.fullName.trim(),
          role: form.role,
          active: form.active
        };
        if (form.password) payload.password = form.password;
        const response = await authFetch(`http://127.0.0.1:3001/api/users/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          toast(data.error || 'Nao foi possivel atualizar.', 'error');
          return;
        }
        toast('Utilizador atualizado.', 'success');
      } else {
        if (form.password.length < 8) {
          toast('Password tem de ter pelo menos 8 caracteres.', 'error');
          return;
        }
        const response = await authFetch('http://127.0.0.1:3001/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username.trim(),
            fullName: form.fullName.trim(),
            role: form.role,
            password: form.password,
            active: form.active
          })
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          toast(data.error || 'Nao foi possivel criar.', 'error');
          return;
        }
        toast('Utilizador criado.', 'success');
      }
      closeForm();
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(row: UserRow) {
    if (!(await confirm({
      title: 'Eliminar utilizador',
      message: `Eliminar ${row.fullName} (@${row.username})? Esta ação não pode ser anulada.`,
      tone: 'danger',
      confirmLabel: 'Eliminar'
    }))) return;
    const response = await authFetch(`http://127.0.0.1:3001/api/users/${row.id}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      toast(data.error || 'Nao foi possivel eliminar.', 'error');
      return;
    }
    toast('Utilizador eliminado.', 'success');
    closeForm();
    await load();
  }

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetting || submitting) return;
    if (resetPassword.length < 8) {
      toast('Password tem de ter pelo menos 8 caracteres.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/users/${resetting.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPassword })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toast(data.error || 'Nao foi possivel reiniciar password.', 'error');
        return;
      }
      toast('Password reiniciada.', 'success');
      closeReset();
    } finally {
      setSubmitting(false);
    }
  }

  const visibleUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => {
        const matchesSearch = !q
          || u.fullName.toLowerCase().includes(q)
          || u.username.toLowerCase().includes(q);
        const matchesRole = roleFilter === 'all' || u.role === roleFilter;
        const matchesActive = activeFilter === 'all'
          || (activeFilter === 'active' && u.active)
          || (activeFilter === 'inactive' && !u.active);
        return matchesSearch && matchesRole && matchesActive;
      })
      .sort((a, b) => Number(b.active) - Number(a.active));
  }, [users, search, roleFilter, activeFilter]);

  const counts = useMemo(() => users.reduce(
    (acc, user) => {
      acc.total += 1;
      if (user.active) acc.active += 1;
      acc.byRole[user.role] = (acc.byRole[user.role] ?? 0) + 1;
      return acc;
    },
    { total: 0, active: 0, byRole: {} as Record<UserRole, number> }
  ), [users]);

  const hasFilter = !!search.trim() || roleFilter !== 'all' || activeFilter !== 'all';

  return (
    <section className="module-panel">
      <div className="module-header users-header">
        <div>
          <p className="eyebrow">Equipa</p>
          <h2>Utilizadores</h2>
          {counts.total > 0 && (
            <p className="users-summary">
              <span className="users-summary-figure">{String(counts.active).padStart(2, '0')}</span>
              <span>ativos</span>
              <span className="users-summary-divider" aria-hidden>/</span>
              <span>{counts.total} total</span>
            </p>
          )}
        </div>
        <div className="inline-actions">
          <Button size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={openCreate}>
            Novo utilizador
          </Button>
        </div>
      </div>

      {counts.total > 3 && (
        <div className="users-filter-sticky">
          <FilterBar>
            <Field
              type="search"
              label="Buscar"
              aria-label="Pesquisar utilizadores"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nome ou username"
            />
            <Select
              label="Perfil"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value as 'all' | UserRole)}
            >
              <option value="all">Todos</option>
              <option value="admin">Admin</option>
              <option value="operator">Operadora</option>
              <option value="technician">Tecnico</option>
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
            {hasFilter && (
              <Button
                variant="secondary"
                onClick={() => { setSearch(''); setRoleFilter('all'); setActiveFilter('all'); }}
              >
                Limpar filtros
              </Button>
            )}
            <small>{visibleUsers.length} {visibleUsers.length === 1 ? 'utilizador' : 'utilizadores'}</small>
          </FilterBar>
        </div>
      )}

      {loading && <SkeletonList rows={5} />}

      {!loading && visibleUsers.length === 0 && (
        <EmptyState
          icon={UsersRound}
          title={hasFilter ? 'Nenhum utilizador encontrado' : 'Sem utilizadores ainda'}
          description={hasFilter
            ? 'Ajusta os filtros ou cria um novo utilizador.'
            : 'Adiciona a equipa para começar a trabalhar em conjunto.'}
        />
      )}

      {!loading && visibleUsers.length > 0 && (
        <div className="users-list">
          {visibleUsers.map((row) => {
            const isSelf = auth.user?.id === row.id;
            const classes = ['user-row'];
            if (!row.active) classes.push('is-inactive');
            if (isSelf) classes.push('is-self');
            return (
              <article key={row.id} className={classes.join(' ')}>
                <div className="user-row-main">
                  <div className="user-row-identity">
                    <span className="user-row-mark" aria-hidden>{row.fullName.charAt(0).toUpperCase()}</span>
                    <div className="user-row-identity-text">
                      <p className="user-row-name">
                        <span
                          className="user-row-state-dot"
                          data-state={row.active ? 'active' : 'inactive'}
                          aria-hidden
                        />
                        {row.fullName}
                        {isSelf && <span className="user-row-self"> (tu)</span>}
                      </p>
                      <p className="user-row-username">@{row.username}</p>
                    </div>
                  </div>
                  <span className={`user-role-pill user-role-${row.role}`}>
                    {ROLE_ICON[row.role]} {ROLE_LABEL[row.role]}
                  </span>
                </div>
                <div className="user-row-meta">
                  <Button
                    variant="icon"
                    size="sm"
                    title="Editar utilizador"
                    aria-label={`Editar ${row.fullName}`}
                    onClick={() => openEdit(row)}
                  >
                    <Pencil size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="icon"
                    size="sm"
                    title="Reiniciar password"
                    aria-label={`Reiniciar password de ${row.fullName}`}
                    onClick={() => openReset(row)}
                  >
                    <KeyRound size={14} aria-hidden />
                  </Button>
                  {!isSelf && (
                    <Button
                      variant="icon"
                      size="sm"
                      title="Eliminar utilizador"
                      aria-label={`Eliminar ${row.fullName}`}
                      onClick={() => void remove(row)}
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Dialog
        open={showForm}
        onClose={closeForm}
        eyebrow={editing ? 'Editar utilizador' : 'Novo utilizador'}
        title={editing ? editing.fullName : 'Conta nova'}
        size="md"
        actions={
          <>
            <Button variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" form="user-form" loading={submitting}>
              {editing ? 'Guardar' : 'Criar'}
            </Button>
          </>
        }
      >
        <form id="user-form" className="client-form" onSubmit={submit}>
          <Field label="Nome completo" type="text" value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
          <Field label="Username" type="text" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required minLength={2} disabled={!!editing} />
          <Select label="Perfil" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}>
            <option value="admin">Admin - acesso total</option>
            <option value="operator">Operadora - gestao corrente</option>
            <option value="technician">Tecnico - campo + OS</option>
          </Select>
          <Select label="Estado" value={form.active ? '1' : '0'} onChange={(event) => setForm({ ...form, active: event.target.value === '1' })}>
            <option value="1">Ativo</option>
            <option value="0">Inativo</option>
          </Select>
          <Field wide label={editing ? 'Nova password (deixa vazio para manter)' : 'Password (min. 8)'} type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} minLength={editing ? 0 : 8} autoComplete="new-password" />
        </form>
      </Dialog>

      <Dialog
        open={!!resetting}
        onClose={closeReset}
        eyebrow="Password"
        title={resetting ? `Reiniciar @${resetting.username}` : 'Reiniciar password'}
        size="sm"
        actions={
          <>
            <Button variant="secondary" onClick={closeReset}>Cancelar</Button>
            <Button type="submit" form="reset-password-form" loading={submitting}>
              Reiniciar
            </Button>
          </>
        }
      >
        <form id="reset-password-form" className="client-form" onSubmit={submitReset}>
          <Field wide label="Nova password" type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} minLength={8} autoComplete="new-password" required />
        </form>
      </Dialog>
    </section>
  );
}

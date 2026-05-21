import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserCog, Wrench } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Badge, Dialog, useToast } from '../components';
import { authFetch, useAuth } from '../lib/auth';
import type { UserRole } from '../lib/auth';

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
  const auth = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setLoading(true);
    return authFetch('http://127.0.0.1:3001/api/users')
      .then((res) => {
        if (!res.ok) throw new Error('load failed');
        return res.json() as Promise<UserRow[]>;
      })
      .then(setUsers)
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    void load();
  }, []);

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
    if (!confirm(`Eliminar ${row.fullName} (@${row.username})?`)) return;
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

  const sortedUsers = [...users].sort((a, b) => Number(b.active) - Number(a.active));
  const counts = users.reduce(
    (acc, user) => {
      acc.total += 1;
      if (user.active) acc.active += 1;
      acc.byRole[user.role] = (acc.byRole[user.role] ?? 0) + 1;
      return acc;
    },
    { total: 0, active: 0, byRole: {} as Record<UserRole, number> }
  );

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
          <button type="button" className="primary" onClick={openCreate}>
            <Plus size={14} aria-hidden /> Novo utilizador
          </button>
        </div>
      </div>

      {loading && <p className="muted">A carregar...</p>}

      {!loading && (
        <div className="users-list">
          {sortedUsers.map((row) => {
            const isSelf = auth.user?.id === row.id;
            return (
              <article
                key={row.id}
                className={`user-row${row.active ? '' : ' is-inactive'}`}
              >
                <div className="user-row-main">
                  <div className="user-row-identity">
                    <span className="user-row-mark">{row.fullName.charAt(0).toUpperCase()}</span>
                    <div>
                      <p className="user-row-name">
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
                  <Badge tone={row.active ? 'success' : 'neutral'}>
                    {row.active ? 'Ativo' : 'Inativo'}
                  </Badge>
                  <button
                    type="button"
                    className="row-action"
                    title="Editar utilizador"
                    aria-label="Editar utilizador"
                    onClick={() => openEdit(row)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="row-action"
                    title="Reiniciar password"
                    aria-label="Reiniciar password"
                    onClick={() => openReset(row)}
                  >
                    <KeyRound size={14} />
                  </button>
                  {!isSelf && (
                    <button
                      type="button"
                      className="row-action"
                      title="Eliminar utilizador"
                      aria-label="Eliminar utilizador"
                      onClick={() => void remove(row)}
                    >
                      <Trash2 size={14} />
                    </button>
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
            <button type="button" onClick={closeForm}>Cancelar</button>
            <button type="submit" form="user-form" className="primary" disabled={submitting}>
              {editing ? 'Guardar' : 'Criar'}
            </button>
          </>
        }
      >
        <form id="user-form" className="client-form" onSubmit={submit}>
          <label>
            <span>Nome completo</span>
            <input
              type="text"
              value={form.fullName}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              required
            />
          </label>
          <label>
            <span>Username</span>
            <input
              type="text"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              required
              minLength={2}
              disabled={!!editing}
            />
          </label>
          <label>
            <span>Perfil</span>
            <select
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value as UserRole })}
            >
              <option value="admin">Admin — acesso total</option>
              <option value="operator">Operadora — gestao corrente</option>
              <option value="technician">Tecnico — campo + OS</option>
            </select>
          </label>
          <label>
            <span>Estado</span>
            <select
              value={form.active ? '1' : '0'}
              onChange={(event) => setForm({ ...form, active: event.target.value === '1' })}
            >
              <option value="1">Ativo</option>
              <option value="0">Inativo</option>
            </select>
          </label>
          <label className="wide-field">
            <span>{editing ? 'Nova password (deixa vazio para manter)' : 'Password (min. 8)'}</span>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              minLength={editing ? 0 : 8}
              autoComplete="new-password"
            />
          </label>
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
            <button type="button" onClick={closeReset}>Cancelar</button>
            <button type="submit" form="reset-password-form" className="primary" disabled={submitting}>
              Reiniciar
            </button>
          </>
        }
      >
        <form id="reset-password-form" className="client-form" onSubmit={submitReset}>
          <label className="wide-field">
            Nova password
            <input
              type="password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              minLength={8}
              autoComplete="new-password"
              required
            />
          </label>
        </form>
      </Dialog>
    </section>
  );
}

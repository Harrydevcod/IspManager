import { useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Message, Select, Textarea, Toggle } from '../../components';
import { authFetch } from '../../lib/auth';
import { formatCve, formatPtDate } from '../../lib/format';
import {
  MOVEMENT_KIND_LABEL,
  TREASURY_API,
  accountLabel,
  type TreasuryAccount,
  type TreasuryAccountKind,
  type TreasuryMovement
} from '../../lib/treasury';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseMoney(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** POST/PATCH com a mensagem de erro do backend, que já vem em pt-PT e diz o que corrigir. */
async function send(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const response = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: (data as { error?: string }).error || 'Não foi possível gravar.' };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Backend indisponível.' };
  }
}

// ---------------------------------------------------------------------------
// Conta (caixa ou banco)
// ---------------------------------------------------------------------------

type AccountForm = {
  name: string;
  bankName: string;
  accountNumber: string;
  holderName: string;
  reference: string;
  openingBalanceCve: string;
  openingDate: string;
  isDefaultCash: boolean;
  showOnDocuments: boolean;
  active: boolean;
};

function accountForm(account: TreasuryAccount | null, kind: TreasuryAccountKind): AccountForm {
  return {
    name: account?.name ?? '',
    bankName: account?.bankName ?? '',
    accountNumber: account?.accountNumber ?? '',
    holderName: account?.holderName ?? '',
    reference: account?.reference ?? '',
    openingBalanceCve: account ? String(account.openingBalanceCve) : '0',
    openingDate: account?.openingDate ?? todayIso(),
    isDefaultCash: account?.isDefaultCash ?? false,
    showOnDocuments: account?.showOnDocuments ?? kind === 'banco',
    active: account?.active ?? true
  };
}

export function AccountDialog({ open, kind, account, onClose, onSaved }: {
  open: boolean;
  kind: TreasuryAccountKind;
  account: TreasuryAccount | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<AccountForm>(() => accountForm(account, kind));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const effectiveKind = account?.kind ?? kind;
  const isBank = effectiveKind === 'banco';

  useEffect(() => {
    if (open) { setForm(accountForm(account, kind)); setError(null); }
  }, [open, account, kind]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const opening = parseMoney(form.openingBalanceCve || '0');
    if (!Number.isFinite(opening)) { setError('Saldo de abertura inválido.'); return; }
    setSubmitting(true);
    const body = {
      name: form.name.trim(),
      openingBalanceCve: opening,
      openingDate: form.openingDate,
      active: form.active,
      ...(isBank
        ? {
            bankName: form.bankName.trim() || null,
            accountNumber: form.accountNumber.trim() || null,
            holderName: form.holderName.trim() || null,
            reference: form.reference.trim() || null,
            showOnDocuments: form.showOnDocuments
          }
        : { isDefaultCash: form.isDefaultCash })
    };
    const result = account
      ? await send(`${TREASURY_API}/accounts/${account.id}`, 'PATCH', body)
      : await send(`${TREASURY_API}/accounts`, 'POST', { kind: effectiveKind, ...body });
    setSubmitting(false);
    if (!result.ok) { setError(result.error); return; }
    onSaved(account ? 'Conta atualizada.' : `${isBank ? 'Conta bancária' : 'Caixa'} criada.`);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow={account ? 'Editar conta' : isBank ? 'Nova conta bancária' : 'Nova caixa'}
      title={account ? account.name : isBank ? 'Conta bancária' : 'Caixa'}
      size="md"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="treasury-account-form" disabled={submitting}>{account ? 'Atualizar' : 'Criar'}</Button>
        </>
      }
    >
      <form id="treasury-account-form" className="client-form" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}
        <Field
          label="Nome"
          required
          maxLength={80}
          value={form.name}
          placeholder={isBank ? 'BCA conta corrente' : 'Caixa do escritório'}
          onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
        />
        {isBank && (
          <>
            <Field label="Banco" maxLength={80} value={form.bankName} onChange={(event) => setForm((f) => ({ ...f, bankName: event.target.value }))} />
            <Field label="Número / NIB / IBAN" maxLength={60} value={form.accountNumber} onChange={(event) => setForm((f) => ({ ...f, accountNumber: event.target.value }))} />
            <Field label="Titular" maxLength={120} value={form.holderName} onChange={(event) => setForm((f) => ({ ...f, holderName: event.target.value }))} />
            <Field label="Referência" maxLength={120} value={form.reference} onChange={(event) => setForm((f) => ({ ...f, reference: event.target.value }))} />
          </>
        )}
        <Field
          label="Saldo de abertura (CVE)"
          type="number"
          step="0.01"
          value={form.openingBalanceCve}
          onChange={(event) => setForm((f) => ({ ...f, openingBalanceCve: event.target.value }))}
          hint={isBank ? 'O saldo do extrato nesta data.' : 'O dinheiro contado na caixa nesta data.'}
        />
        <Field
          label="Data de abertura"
          type="date"
          required
          max={todayIso()}
          value={form.openingDate}
          onChange={(event) => setForm((f) => ({ ...f, openingDate: event.target.value }))}
          hint="Só contam os movimentos a partir desta data."
        />
        {isBank ? (
          <Toggle
            title="Mostrar nas faturas"
            description="O banco e o número saem no rodapé das faturas."
            checked={form.showOnDocuments}
            onChange={(event) => setForm((f) => ({ ...f, showOnDocuments: event.target.checked }))}
          />
        ) : (
          <Toggle
            title="Caixa predefinida para numerário"
            description="O dinheiro recebido em numerário entra aqui, a menos que se escolha outra caixa."
            checked={form.isDefaultCash}
            disabled={account?.isDefaultCash}
            onChange={(event) => setForm((f) => ({ ...f, isDefaultCash: event.target.checked }))}
          />
        )}
        {account && (
          <Toggle
            title="Conta ativa"
            description={account.isDefaultCash ? 'A caixa predefinida não pode ser desativada.' : 'Uma conta desativada deixa de aparecer nos seletores; o histórico fica.'}
            checked={form.active}
            disabled={account.isDefaultCash}
            onChange={(event) => setForm((f) => ({ ...f, active: event.target.checked }))}
          />
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Depósito / transferência
// ---------------------------------------------------------------------------

export function TransferDialog({ open, accounts, initialFromId, isAdmin, onClose, onSaved }: {
  open: boolean;
  accounts: TreasuryAccount[];
  initialFromId?: number | null;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const active = accounts.filter((account) => account.active);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Por omissão é o depósito da caixa predefinida no primeiro banco.
    const from = active.find((a) => a.id === initialFromId) ?? active.find((a) => a.isDefaultCash) ?? active[0];
    const to = active.find((a) => a.kind === 'banco' && a.id !== from?.id);
    setFromId(from ? String(from.id) : '');
    setToId(to ? String(to.id) : '');
    setAmount(from && from.kind === 'caixa' && from.balanceCve > 0 ? String(from.balanceCve) : '');
    setDate(todayIso());
    setReference('');
    setNotes('');
    setAllowNegative(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFromId]);

  const from = active.find((a) => String(a.id) === fromId);
  const to = active.find((a) => String(a.id) === toId);
  const value = parseMoney(amount);
  const isDeposit = from?.kind === 'caixa' && to?.kind === 'banco';
  const insufficient = Boolean(from && Number.isFinite(value) && value > from.balanceCve);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!from || !to || !(value > 0)) { setError('Escolha as duas contas e um valor positivo.'); return; }
    setSubmitting(true);
    const result = await send(`${TREASURY_API}/transfers`, 'POST', {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCve: value,
      movementDate: date,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      allowNegative: allowNegative || undefined
    });
    setSubmitting(false);
    if (!result.ok) { setError(result.error); return; }
    onSaved(`${isDeposit ? 'Depósito' : 'Transferência'} de ${formatCve(value)} registado.`);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Tesouraria"
      title={isDeposit ? 'Depositar no banco' : 'Transferir entre contas'}
      size="md"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="treasury-transfer-form" disabled={submitting || (insufficient && !allowNegative)}>
            {isDeposit ? 'Registar depósito' : 'Registar transferência'}
          </Button>
        </>
      }
    >
      <form id="treasury-transfer-form" className="client-form" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}
        <Select label="De" required value={fromId} onChange={(event) => setFromId(event.target.value)}>
          <option value="">Escolher…</option>
          {active.map((a) => (
            <option key={a.id} value={String(a.id)}>{accountLabel(a)} — {formatCve(a.balanceCve)}</option>
          ))}
        </Select>
        <Select label="Para" required value={toId} onChange={(event) => setToId(event.target.value)}>
          <option value="">Escolher…</option>
          {active.filter((a) => String(a.id) !== fromId).map((a) => (
            <option key={a.id} value={String(a.id)}>{accountLabel(a)}</option>
          ))}
        </Select>
        <Field
          label="Valor (CVE)"
          type="number"
          min="0.01"
          step="0.01"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={insufficient && !allowNegative ? `Saldo disponível: ${formatCve(from!.balanceCve)}` : undefined}
        />
        <Field label="Data" type="date" required max={todayIso()} value={date} onChange={(event) => setDate(event.target.value)} />
        <Field
          label={isDeposit ? 'Nº do talão' : 'Referência'}
          maxLength={80}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <Field label="Notas" maxLength={240} value={notes} onChange={(event) => setNotes(event.target.value)} />
        {insufficient && isAdmin && (
          <Toggle
            title="Registar mesmo assim"
            description="A conta de origem fica com saldo negativo. Só para acertar um saldo de abertura em falta."
            checked={allowNegative}
            onChange={(event) => setAllowNegative(event.target.checked)}
          />
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Contagem de caixa
// ---------------------------------------------------------------------------

export function CashCountDialog({ open, accounts, initialAccountId, onClose, onSaved }: {
  open: boolean;
  accounts: TreasuryAccount[];
  initialAccountId?: number | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const boxes = accounts.filter((account) => account.active && account.kind === 'caixa');
  const [accountId, setAccountId] = useState('');
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const initial = boxes.find((a) => a.id === initialAccountId) ?? boxes.find((a) => a.isDefaultCash) ?? boxes[0];
    setAccountId(initial ? String(initial.id) : '');
    setCounted('');
    setReason('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAccountId]);

  const account = boxes.find((a) => String(a.id) === accountId);
  const value = parseMoney(counted);
  const difference = account && counted !== '' && Number.isFinite(value)
    ? Math.round((value - account.balanceCve) * 100) / 100
    : null;
  const needsReason = difference !== null && difference !== 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account || difference === null) return;
    setSubmitting(true);
    const result = await send(`${TREASURY_API}/counts`, 'POST', {
      accountId: account.id,
      countedCve: value,
      reason: needsReason ? reason.trim() : null
    });
    setSubmitting(false);
    if (!result.ok) { setError(result.error); return; }
    onSaved(difference === 0
      ? `${account.name}: a contagem bate com o sistema.`
      : `${account.name}: ${difference > 0 ? 'sobra' : 'falta'} de ${formatCve(Math.abs(difference))} registada.`);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Tesouraria"
      title="Contar caixa"
      size="sm"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" form="treasury-count-form" disabled={submitting || difference === null || (needsReason && reason.trim().length < 10)}>
            Registar contagem
          </Button>
        </>
      }
    >
      <form id="treasury-count-form" className="overdue-notify" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}
        <Select label="Caixa" required value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {boxes.map((a) => <option key={a.id} value={String(a.id)}>{accountLabel(a)}</option>)}
        </Select>
        {account && (
          <Message tone="neutral">Saldo no sistema: <strong>{formatCve(account.balanceCve)}</strong></Message>
        )}
        <Field
          label="Contado na caixa (CVE)"
          type="number"
          min="0"
          step="0.01"
          required
          value={counted}
          onChange={(event) => setCounted(event.target.value)}
        />
        {difference !== null && (
          <Message tone={difference === 0 ? 'success' : 'error'}>
            {difference === 0
              ? 'Bate certo. Nada a lançar.'
              : `${difference > 0 ? 'Sobra' : 'Falta'} de ${formatCve(Math.abs(difference))}. Fica registada como ajuste.`}
          </Message>
        )}
        {needsReason && (
          <Textarea
            label="Explicação da diferença"
            required
            rows={2}
            maxLength={240}
            value={reason}
            placeholder="Mínimo 10 caracteres"
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Estorno
// ---------------------------------------------------------------------------

export function ReverseMovementDialog({ movement, onClose, onSaved }: {
  movement: TreasuryMovement | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setReason(''); setError(null); }, [movement]);

  if (!movement) return null;
  const pair = movement.transferGroup ? ' Os dois lados (saída e entrada) são estornados juntos.' : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!movement) return;
    setSubmitting(true);
    const result = await send(`${TREASURY_API}/movements/${movement.id}/reverse`, 'POST', { reason: reason.trim() });
    setSubmitting(false);
    if (!result.ok) { setError(result.error); return; }
    onSaved('Movimento estornado.');
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Estornar movimento"
      title={`${MOVEMENT_KIND_LABEL[movement.kind]} de ${formatCve(movement.amountCve)}`}
      size="sm"
      actions={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button type="submit" variant="danger" form="treasury-reverse-form" disabled={submitting || reason.trim().length < 10}>
            Estornar
          </Button>
        </>
      }
    >
      <form id="treasury-reverse-form" className="overdue-notify" onSubmit={submit}>
        {error && <Message tone="error">{error}</Message>}
        <Message tone="neutral">
          {formatPtDate(movement.movementDate)} · {movement.accountName} · {movement.description}.
          Nada se apaga: fica um movimento de sinal contrário com o motivo.{pair}
        </Message>
        <Textarea
          label="Motivo"
          required
          rows={2}
          maxLength={240}
          value={reason}
          placeholder="Mínimo 10 caracteres"
          onChange={(event) => setReason(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

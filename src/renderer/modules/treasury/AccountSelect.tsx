import { useEffect } from 'react';
import { Select } from '../../components';
import { accountLabel, accountsFor, useTreasuryAccounts, type AccountPurpose } from '../../lib/treasury';

const LABEL: Record<AccountPurpose, string> = {
  numerario: 'Caixa',
  transferencia: 'Banco de destino',
  outro: 'Conta de destino',
  saida: 'Pago por'
};

type AccountSelectProps = {
  purpose: AccountPurpose;
  /** Id da conta como texto; '' = nenhuma. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Onde o dinheiro entra ou de onde sai.
 *
 * Numerário escolhe só caixas e vem com a predefinida; transferência só
 * bancos. Com uma única conta possível, fica já escolhida. Numa saída (despesa,
 * investimento) a conta é opcional: sem ela não se regista movimento.
 */
export function AccountSelect({ purpose, value, onChange, disabled, className }: AccountSelectProps) {
  const { accounts, loaded } = useTreasuryAccounts();
  const options = accountsFor(purpose, accounts);
  const required = purpose !== 'saida';

  useEffect(() => {
    if (!loaded || value || !required) return;
    const preferred = purpose === 'numerario' ? options.find((account) => account.isDefaultCash) : undefined;
    const pick = preferred ?? (options.length === 1 ? options[0] : undefined);
    if (pick) onChange(String(pick.id));
    // `options` deriva de `accounts`; reagir a ela a cada render repetiria a escolha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, value, purpose, accounts]);

  // Um valor que deixou de caber (mudou o método) volta a vazio para ser escolhido de novo.
  // Numa saída já gravada não: a conta pode ter sido desativada depois, e trocar
  // o valor em silêncio estornava a despesa ao gravar.
  useEffect(() => {
    if (!required) return;
    if (loaded && value && !options.some((account) => String(account.id) === value)) onChange('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, value, purpose, accounts]);

  const current = value && !options.some((account) => String(account.id) === value)
    ? accounts.find((account) => String(account.id) === value)
    : undefined;

  const hint = loaded && required && options.length === 0
    ? purpose === 'transferencia'
      ? 'Não há contas bancárias ativas. Crie uma em Tesouraria.'
      : 'Não há caixas ativas. Crie uma em Tesouraria.'
    : undefined;

  return (
    <Select
      label={LABEL[purpose]}
      className={className}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || !loaded}
      required={required}
      error={hint}
    >
      <option value="">{required ? 'Escolher…' : 'Sem registo na tesouraria'}</option>
      {current && <option value={String(current.id)}>{accountLabel(current)} (desativada)</option>}
      {options.map((account) => (
        <option key={account.id} value={String(account.id)}>{accountLabel(account)}</option>
      ))}
    </Select>
  );
}

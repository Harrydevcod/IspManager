import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, Select } from '../../components';
import { CV_ISLANDS, isKnownIsland } from '../../lib/islands';
import type { BankAccountForm, SettingsFormState, UpdateField } from './settingsForm';

type CompanyTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onAddBankAccount: () => void;
  onUpdateBankAccount: (index: number, field: keyof BankAccountForm, value: string) => void;
  onRemoveBankAccount: (index: number) => void;
};

export function CompanyTab({ form, onUpdate, onAddBankAccount, onUpdateBankAccount, onRemoveBankAccount }: CompanyTabProps) {
  return (
    <>
      <Field
        label="Nome da empresa"
        required
        value={form.companyName}
        onChange={(event) => onUpdate('companyName', event.target.value)}
      />
      <Field
        label="NIF"
        value={form.nif}
        onChange={(event) => onUpdate('nif', event.target.value)}
      />
      <Field
        label="Telefone"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        value={form.phone}
        onChange={(event) => onUpdate('phone', event.target.value)}
      />
      <Field
        label="Email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        value={form.email}
        onChange={(event) => onUpdate('email', event.target.value)}
      />
      <Select
        label="Ilha"
        value={form.island}
        onChange={(event) => onUpdate('island', event.target.value)}
      >
        <option value="">—</option>
        {CV_ISLANDS.map((island) => (
          <option key={island} value={island}>{island}</option>
        ))}
        {form.island !== '' && !isKnownIsland(form.island) && (
          <option value={form.island}>{form.island} (grafia antiga)</option>
        )}
      </Select>
      <Field
        wide
        label="Morada"
        value={form.address}
        onChange={(event) => onUpdate('address', event.target.value)}
      />
      <section className="settings-bank-accounts wide-field" aria-label="Contas bancarias da empresa">
        <div className="settings-bank-accounts-head">
          <div>
            <span className="field-label">Contas bancarias</span>
            <small>Dados usados como referencia de pagamento da empresa.</small>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Plus size={14} aria-hidden />}
            onClick={onAddBankAccount}
            disabled={form.bankAccounts.length >= 8}
          >
            Adicionar conta
          </Button>
        </div>

        {form.bankAccounts.length === 0 ? (
          <p className="settings-bank-empty">Nenhuma conta bancaria registada.</p>
        ) : (
          <div className="settings-bank-list">
            {form.bankAccounts.map((account, index) => (
              <article className="settings-bank-item" key={index}>
                <Field
                  label="Banco"
                  value={account.bankName}
                  onChange={(event) => onUpdateBankAccount(index, 'bankName', event.target.value)}
                  placeholder="BCA, Caixa, BCN..."
                />
                <Field
                  label="Titular"
                  value={account.accountName}
                  onChange={(event) => onUpdateBankAccount(index, 'accountName', event.target.value)}
                  placeholder={form.companyName || 'Nome da empresa'}
                />
                <Field
                  label="Numero / NIB / IBAN"
                  value={account.accountNumber}
                  onChange={(event) => onUpdateBankAccount(index, 'accountNumber', event.target.value)}
                  spellCheck={false}
                />
                <Field
                  label="Referencia"
                  value={account.reference}
                  onChange={(event) => onUpdateBankAccount(index, 'reference', event.target.value)}
                  placeholder="Pagamentos, instalacoes..."
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="settings-bank-remove"
                  leadingIcon={<Trash2 size={14} aria-hidden />}
                  onClick={() => onRemoveBankAccount(index)}
                  aria-label={`Remover conta bancaria ${index + 1}`}
                >
                  Remover
                </Button>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

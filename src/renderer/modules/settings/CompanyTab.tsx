import { Field, Select } from '../../components';
import { CV_ISLANDS, isKnownIsland } from '../../lib/islands';
import type { SettingsFormState, UpdateField } from './settingsForm';

type CompanyTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
};

export function CompanyTab({ form, onUpdate }: CompanyTabProps) {
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
      {/* Desde a Tesouraria (0058) as contas bancarias vivem la, com saldo e
          extrato; as marcadas "Mostrar nas faturas" saem no PDF. */}
      <p className="settings-bank-moved wide-field">
        As contas bancárias passaram para o módulo <strong>Tesouraria</strong>, onde têm saldo e movimentos.
        Lá decide-se também quais aparecem nas faturas.
      </p>
    </>
  );
}

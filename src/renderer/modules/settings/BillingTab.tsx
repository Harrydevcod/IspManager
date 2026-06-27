import { Field, Select, Textarea, Toggle } from '../../components';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

type BillingTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
};

export function BillingTab({ form, onUpdate, onToggle }: BillingTabProps) {
  return (
    <>
      <Field
        label="Dia de geração automática das faturas"
        required
        type="number"
        min={1}
        max={31}
        value={form.autoBillingDay}
        onChange={(event) => onUpdate('autoBillingDay', event.target.value)}
        hint="Ao fechar o mês (dia 30), gera as faturas com competência desse mês. Recupera meses não abertos."
      />
      <Field
        label="Dia padrão de vencimento"
        required
        type="number"
        min={1}
        max={31}
        value={form.defaultDueDay}
        onChange={(event) => onUpdate('defaultDueDay', event.target.value)}
        hint="Referência informativa. O vencimento real é a data de emissão + 30 dias."
      />
      <Field
        label="Moeda"
        required
        value={form.currencyCode}
        onChange={(event) => onUpdate('currencyCode', event.target.value)}
      />
      <Field
        label="Prefixo fatura"
        required
        value={form.invoicePrefix}
        onChange={(event) => onUpdate('invoicePrefix', event.target.value)}
      />
      <Field
        label="Prefixo recibo"
        required
        value={form.receiptPrefix}
        onChange={(event) => onUpdate('receiptPrefix', event.target.value)}
      />
      <Select
        label="Regime fiscal"
        value={form.fiscalRegime}
        onChange={(event) => onUpdate('fiscalRegime', event.target.value as 'normal' | 'rempe')}
      >
        <option value="normal">Regime Normal (com IVA)</option>
        <option value="rempe">REMPE (isento IVA)</option>
      </Select>
      <Field
        label="Taxa de IVA (%)"
        required
        type="number"
        min={0}
        max={100}
        step={0.5}
        value={form.ivaRate}
        onChange={(event) => onUpdate('ivaRate', event.target.value)}
      />
      <Textarea
        label="Observações no documento"
        rows={3}
        value={form.legalNotes}
        onChange={(event) => onUpdate('legalNotes', event.target.value)}
        placeholder="Texto opcional que aparece no rodapé de cada fatura/recibo (ex: termos, IBAN, agradecimento)"
      />
      <Toggle
        title="Mostrar linha de IVA nos documentos"
        description="Quando desligado, fatura/recibo mostram apenas o total (serviço informal). Liga quando estiveres com contabilidade organizada."
        checked={form.showIva}
        onChange={(event) => onToggle('showIva', event.target.checked)}
      />
      <Toggle
        title="Imprimir QR Code fiscal nos documentos"
        description="QR no formato Portaria 47/2021 (preparatório para e-Fatura). Liga quando estiveres preparado para credenciação na DNRE."
        checked={form.printQrCode}
        onChange={(event) => onToggle('printQrCode', event.target.checked)}
      />
      <Toggle
        title="Conteúdos audiovisuais"
        description="Permite oferecer o serviço aos clientes. Mensal entra na fatura da internet; anual é faturado à parte."
        checked={form.audiovisualEnabled}
        onChange={(event) => onToggle('audiovisualEnabled', event.target.checked)}
      />
      {form.audiovisualEnabled && (
        <>
          <Field
            label="Denominação na fatura"
            required
            value={form.audiovisualLabel}
            onChange={(event) => onUpdate('audiovisualLabel', event.target.value)}
            hint="Designação legal impressa nos documentos (evitar &quot;IPTV&quot;)."
          />
          <Field
            label="Valor mensal CVE"
            type="number"
            min={0}
            value={form.audiovisualMonthlyCve}
            onChange={(event) => onUpdate('audiovisualMonthlyCve', event.target.value)}
          />
          <Field
            label="Valor anual CVE"
            type="number"
            min={0}
            value={form.audiovisualAnnualCve}
            onChange={(event) => onUpdate('audiovisualAnnualCve', event.target.value)}
          />
        </>
      )}
    </>
  );
}

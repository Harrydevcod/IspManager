import { Message, SecretField, Toggle, type SecretDraft } from '../../components';
import { AccountSelect } from '../treasury/AccountSelect';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

type PaymentTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  secretDraft: SecretDraft;
  onSecretDraftChange: (next: SecretDraft) => void;
};

/**
 * Vias de pagamento online. O Vinti4 é a principal (ADR 0019): a rede dos
 * cartões de Cabo Verde, por EasyLink. O Stripe fica como via secundária
 * (ADR 0016). Desligadas, nenhuma aparece nas faturas.
 */
export function PaymentTab({ form, onUpdate, onToggle, secretDraft, onSecretDraftChange }: PaymentTabProps) {
  return (
    <>
      <header className="settings-group-head wide-field">
        <span className="settings-group-eyebrow">Via principal</span>
        <h3>Vinti4</h3>
      </header>
      <Toggle
        title="Ativar pagamentos por Vinti4"
        description="Acrescenta o Vinti4 às vias de pagamento de uma fatura: cola-se na fatura um EasyLink criado no Portal do Comerciante, o link segue nos avisos de WhatsApp e SMS e o cliente paga com cartão vinti4, Visa ou Mastercard."
        checked={form.vinti4Enabled}
        onChange={(event) => onToggle('vinti4Enabled', event.target.checked)}
      />
      {form.vinti4Enabled && (
        <>
          <AccountSelect
            purpose="transferencia"
            value={form.vinti4TreasuryAccountId}
            onChange={(value) => onUpdate('vinti4TreasuryAccountId', value)}
          />
          <Message tone="neutral">
            O SISP não avisa o ISPM quando um link é pago. Crie o EasyLink em comerciante.vinti4.cv pelo saldo da fatura e cole-o na ficha dela; quando o portal o mostrar como Pago, registe o recibo na ficha. O link só segue nos avisos enquanto o valor dele for o saldo, e só nos modelos que tenham a variável {'{link}'}. Comissões do SISP: 0,7% com cartão vinti4 e 2,5% com Visa ou Mastercard, mais IVA.
          </Message>
        </>
      )}

      <header className="settings-group-head wide-field">
        <span className="settings-group-eyebrow">Via secundária</span>
        <h3>Stripe</h3>
      </header>
      <Toggle
        title="Ativar pagamentos por Stripe"
        description="Acrescenta o Stripe às vias de pagamento de uma fatura: o ISPM gera um link, o cliente paga por cartão e o recibo é registado sozinho. Numerário e transferência continuam a funcionar como sempre."
        checked={form.stripeEnabled}
        onChange={(event) => onToggle('stripeEnabled', event.target.checked)}
      />
      {form.stripeEnabled && (
        <>
          <SecretField label="Chave da API do Stripe" configured={Boolean(form.stripeSecretKeyConfigured)}
            draft={secretDraft} onDraftChange={(next) => { onSecretDraftChange(next); onUpdate('stripeSecretKey', next.editing ? next.value : ''); }} />
          <AccountSelect
            purpose="transferencia"
            value={form.stripeTreasuryAccountId}
            onChange={(value) => onUpdate('stripeTreasuryAccountId', value)}
          />
          <Message tone="neutral">
            Use uma chave restrita (rk_live_…) com escrita em Customers, Invoices, Invoice Items e Refunds, e leitura em PaymentIntents, Charges e Balance Transactions. O banco de destino é a conta da Tesouraria onde o Stripe deposita: é lá que entra cada recibo e de lá que sai a comissão do Stripe, registada como despesa. A cobrança é feita em {form.currencyCode || 'CVE'}, a moeda das faturas, e os pagamentos são confirmados de 5 em 5 minutos. Se uma fatura tiver link Vinti4 e Stripe, os avisos levam o do Vinti4.
          </Message>
        </>
      )}
    </>
  );
}

import { Message, SecretField, Toggle, type SecretDraft } from '../../components';
import { AccountSelect } from '../treasury/AccountSelect';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

type StripeTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  secretDraft: SecretDraft;
  onSecretDraftChange: (next: SecretDraft) => void;
};

/**
 * Stripe como mais uma via de pagamento (ADR 0016). Desligado, o ISPM fica
 * como sempre: a opção não aparece nas faturas e nada fala com o Stripe.
 */
export function StripeTab({ form, onUpdate, onToggle, secretDraft, onSecretDraftChange }: StripeTabProps) {
  return (
    <>
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
            Use uma chave restrita (rk_live_…) com escrita em Customers, Invoices, Invoice Items e Refunds, e leitura em PaymentIntents, Charges e Balance Transactions. O banco de destino é a conta da Tesouraria onde o Stripe deposita: é lá que entra cada recibo e de lá que sai a comissão do Stripe, registada como despesa. A cobrança é feita em {form.currencyCode || 'CVE'}, a moeda das faturas, e os pagamentos são confirmados de 5 em 5 minutos. Para um aviso de WhatsApp ou SMS levar o link de uma fatura que o tenha, o modelo precisa da variável {'{link}'}.
          </Message>
        </>
      )}
    </>
  );
}

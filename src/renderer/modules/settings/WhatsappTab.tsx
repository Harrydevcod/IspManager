import { Button, Field, Message, SecretField, Select, Toggle, type SecretDraft } from '../../components';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import { TemplateField } from './TemplateField';
import {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappTestTemplate
} from '../../../shared/whatsapp';
import { type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';

type TestMessage = { tone: 'neutral' | 'success' | 'error'; text: string } | null;

type WhatsappTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  secretDraft?: SecretDraft;
  onSecretDraftChange?: (next: SecretDraft) => void;
  metaSecretDraft?: SecretDraft;
  onMetaSecretDraftChange?: (next: SecretDraft) => void;
  onToggle: ToggleField;
  testPhone: string;
  onTestPhoneChange: (value: string) => void;
  testMessage: TestMessage;
  testSending: boolean;
  onSendTest: () => void;
};

export function WhatsappTab({ form, onUpdate, secretDraft = { editing: false }, onSecretDraftChange = () => undefined, metaSecretDraft = { editing: false }, onMetaSecretDraftChange = () => undefined, onToggle, testPhone, onTestPhoneChange, testMessage, testSending, onSendTest }: WhatsappTabProps) {
  const usesMeta = form.whatsappProvider === 'meta-cloud';
  return (
    <>
      <Select
        label="Fornecedor"
        value={form.whatsappProvider}
        onChange={(event) => onUpdate('whatsappProvider', event.target.value)}
      >
        <option value="ultramsg">UltraMsg</option>
        <option value="meta-cloud">Meta Cloud API (oficial)</option>
      </Select>
      {usesMeta ? (
        <>
          <Field
            label="ID do número (Phone number ID)"
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            value={form.metaPhoneNumberId}
            onChange={(event) => onUpdate('metaPhoneNumberId', event.target.value.replace(/\D/g, ''))}
            placeholder="105500000000000"
          />
          <SecretField label="Token de acesso Meta" configured={Boolean(form.metaAccessTokenConfigured)}
            draft={metaSecretDraft} onDraftChange={(next) => { onMetaSecretDraftChange(next); onUpdate('metaAccessToken', next.editing ? next.value : ''); }} />
        </>
      ) : (
        <>
          <Field
            label="UltraMsg instance ID"
            autoComplete="off"
            spellCheck={false}
            value={form.ultraMsgInstanceId}
            onChange={(event) => onUpdate('ultraMsgInstanceId', event.target.value)}
            placeholder="instance00000"
          />
          <SecretField label="Token UltraMsg" configured={Boolean(form.ultraMsgTokenConfigured)}
            draft={secretDraft} onDraftChange={(next) => { onSecretDraftChange(next); onUpdate('ultraMsgToken', next.editing ? next.value : ''); }} />
        </>
      )}
      <Field
        label="Avisar suspensao apos X dias"
        type="number"
        min={1}
        max={120}
        value={form.whatsappSuspensionNoticeDays}
        onChange={(event) => onUpdate('whatsappSuspensionNoticeDays', event.target.value)}
      />
      {/* Depois deste campo, para a grelha de duas colunas fechar sem buraco. */}
      {usesMeta && (
        <Message tone="neutral">
          Só entrega a quem escreveu à empresa nas últimas 24 horas.
        </Message>
      )}
      <Toggle
        title="Enviar avisos de atraso automaticamente"
        description="Só com consentimento dos clientes."
        checked={form.autoNoticesEnabled}
        onChange={(event) => onToggle('autoNoticesEnabled', event.target.checked)}
      />
      <Field
        label="Nao repetir o mesmo aviso durante X dias"
        type="number"
        min={1}
        max={90}
        value={form.noticeCooldownDays}
        onChange={(event) => onUpdate('noticeCooldownDays', event.target.value)}
      />
      <TemplateField
        field="whatsappTestTemplate"
        label="Mensagem de teste"
        value={form.whatsappTestTemplate}
        recommended={fallbackWhatsappTestTemplate}
        onUpdate={onUpdate}
      />
      <Field
        label="Telefone para teste"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={testPhone}
        onChange={(event) => onTestPhoneChange(event.target.value)}
        placeholder="9910000 ou 2389910000"
      />
      <div className="settings-test-whatsapp" aria-label="Enviar mensagem de teste">
        <span>Envio de teste</span>
        {testMessage && <Message tone={testMessage.tone}>{testMessage.text}</Message>}
        <Button
          variant="secondary"
          onClick={onSendTest}
          disabled={!normalizeWhatsappPhone(testPhone)}
          loading={testSending}
        >
          {testSending ? 'A enviar teste...' : 'Enviar teste'}
        </Button>
      </div>
      <TemplateField
        field="whatsappTemplate"
        label="Mensagem geral WhatsApp"
        hint="Variáveis: {nome} {codigo} {empresa} {fatura} {recibo} {valor} (2.500$00) {mes} (por extenso) {vencimento} {dias_atraso} {data_suspensao} {link}."
        value={form.whatsappTemplate}
        recommended={fallbackWhatsappTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappInvoiceReadyTemplate"
        label="Fatura do mês pronta"
        value={form.whatsappInvoiceReadyTemplate}
        recommended={fallbackWhatsappInvoiceReadyTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappReceiptTemplate"
        label="Confirmação de recebimento e recibo"
        value={form.whatsappReceiptTemplate}
        recommended={fallbackWhatsappReceiptTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappOverdueTemplate"
        label="Fatura em atraso"
        value={form.whatsappOverdueTemplate}
        recommended={fallbackWhatsappOverdueTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappSuspensionTemplate"
        label="Aviso de suspensão"
        value={form.whatsappSuspensionTemplate}
        recommended={fallbackWhatsappSuspensionTemplate}
        onUpdate={onUpdate}
      />
    </>
  );
}

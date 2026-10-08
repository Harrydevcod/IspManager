import { Button, Field, Message, SecretField, Select, Textarea, Toggle, type SecretDraft } from '../../components';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import { templateRows, type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';

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
          <Message tone="neutral">
            A Cloud API só entrega texto livre a quem escreveu à empresa nas últimas 24 horas. Avisos de fatura, atraso e corte precisam de modelos aprovados pela Meta, que o ISPM ainda não envia: fora dessa janela o envio falha. A confirmação de entrega e de leitura também não está disponível com este fornecedor.
          </Message>
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
      <Toggle
        title="Enviar avisos de atraso automaticamente"
        description="Uma vez por dia, o sistema envia avisos de atraso/suspensao aos clientes elegiveis via WhatsApp. Desligado por defeito — liga so com consentimento dos clientes e o fornecedor configurado."
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
      <Textarea
        className="whatsapp-template-field"
        label="Mensagem de teste"
        rows={templateRows(form.whatsappTestTemplate)}
        value={form.whatsappTestTemplate}
        onChange={(event) => onUpdate('whatsappTestTemplate', event.target.value)}
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
      <Textarea
        className="whatsapp-template-field"
        label="Mensagem geral WhatsApp"
        rows={templateRows(form.whatsappTemplate)}
        value={form.whatsappTemplate}
        onChange={(event) => onUpdate('whatsappTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="Fatura do mes pronta"
        rows={templateRows(form.whatsappInvoiceReadyTemplate)}
        value={form.whatsappInvoiceReadyTemplate}
        onChange={(event) => onUpdate('whatsappInvoiceReadyTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="Confirmacao de recebimento e recibo"
        rows={templateRows(form.whatsappReceiptTemplate)}
        value={form.whatsappReceiptTemplate}
        onChange={(event) => onUpdate('whatsappReceiptTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="Fatura em atraso"
        rows={templateRows(form.whatsappOverdueTemplate)}
        value={form.whatsappOverdueTemplate}
        onChange={(event) => onUpdate('whatsappOverdueTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="Aviso de corte/suspensao"
        rows={templateRows(form.whatsappSuspensionTemplate)}
        value={form.whatsappSuspensionTemplate}
        onChange={(event) => onUpdate('whatsappSuspensionTemplate', event.target.value)}
      />
    </>
  );
}

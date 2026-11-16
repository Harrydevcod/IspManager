import { Button, Field, Message, SecretField, Select, Toggle, type SecretDraft } from '../../components';
import { normalizeWhatsappPhone } from '../../lib/whatsapp';
import { TemplateField } from './TemplateField';
import {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappMaintenanceTemplate,
  fallbackWhatsappOutageTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappReminderTemplate,
  fallbackWhatsappRestoredTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTemplate,
  fallbackWhatsappWarningTemplate,
  fallbackWhatsappTestTemplate
} from '../../../shared/whatsapp';
import { numberMetaVariables } from '../../../shared/whatsapp';
import { type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';
import { useState } from 'react';
import { authFetch } from '../../lib/auth';

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
  const [models, setModels] = useState<Array<{ name: string; language: string; body: string }>>([]);
  const [modelStatus, setModelStatus] = useState('');
  async function loadModels() {
    setModelStatus('A consultar modelos aprovados…');
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/whatsapp/meta/templates');
      const result = await response.json() as { templates?: Array<{ name: string; language: string; body: string }>; error?: string };
      if (!response.ok || !Array.isArray(result.templates)) throw new Error(result.error || 'Não foi possível consultar os modelos.');
      setModels(result.templates);
      setModelStatus(result.templates.length ? 'Modelos aprovados carregados.' : 'Não há modelos de texto aprovados.');
    } catch (error) {
      setModels([]);
      setModelStatus(error instanceof TypeError ? 'Sem ligação ao ISPM. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível consultar os modelos.');
    }
  }
  async function copyForMeta(text: string) {
    const numbered = numberMetaVariables(text);
    try { await navigator.clipboard.writeText(numbered); setModelStatus('Texto copiado para criar o modelo na Meta.'); }
    catch { setModelStatus('Não foi possível copiar. Selecione e copie o texto do campo.'); }
  }
  // Nunca os dois canais desligados: sem o SMS ligado, o WhatsApp não se desliga.
  const lastChannel = form.whatsappChannelEnabled && !form.smsCompanionEnabled;
  return (
    <>
      <Toggle
        title="Canal WhatsApp"
        checked={form.whatsappChannelEnabled}
        disabled={lastChannel}
        onChange={(event) => onToggle('whatsappChannelEnabled', event.target.checked)}
      />
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
          <Field label="ID da conta WhatsApp Business" inputMode="numeric" autoComplete="off" value={form.metaBusinessAccountId}
            onChange={(event) => onUpdate('metaBusinessAccountId', event.target.value.replace(/\D/g, ''))} />
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
      {/* Ao lado do token: a grelha de duas colunas fecha sem buraco. */}
      <Field
        label="Nao repetir o mesmo aviso durante X dias"
        type="number"
        min={1}
        max={90}
        value={form.noticeCooldownDays}
        onChange={(event) => onUpdate('noticeCooldownDays', event.target.value)}
      />
      {usesMeta && (
        <div className="wide-field meta-templates-head">
          <Button
            variant="secondary"
            onClick={() => { void loadModels(); }}
            disabled={!form.metaBusinessAccountId || !form.metaAccessTokenConfigured}
            title={!form.metaBusinessAccountId || !form.metaAccessTokenConfigured ? 'Guarde o ID da conta e o token primeiro' : undefined}
          >
            Consultar modelos aprovados
          </Button>
          {modelStatus && <span role="status">{modelStatus}</span>}
        </div>
      )}
      {/* Um modelo por aviso, na mesma grelha de duas colunas dos outros campos. */}
      {usesMeta && ([
        ['metaTemplateInvoice', 'Fatura emitida'],
        ['metaTemplateReceipt', 'Recibo'],
        ['metaTemplateReminder', 'Lembrete antes do vencimento'],
        ['metaTemplateOverdue', 'Fatura em atraso'],
        ['metaTemplateWarning', 'Aviso de atraso prolongado'],
        ['metaTemplateSuspension', 'Aviso de suspensão'],
        ['metaTemplateOutage', 'Avaria na rede'],
        ['metaTemplateRestored', 'Serviço reposto']
      ] as const).map(([field, label]) => {
        const selected = form[field] || '';
        const chosen = models.find((model) => `${model.name}|${model.language}` === selected);
        const text = field === 'metaTemplateOutage' ? form.whatsappOutageTemplate : field === 'metaTemplateRestored' ? form.whatsappRestoredTemplate : field === 'metaTemplateOverdue' ? form.whatsappOverdueTemplate : field === 'metaTemplateSuspension' ? form.whatsappSuspensionTemplate : field === 'metaTemplateInvoice' ? form.whatsappInvoiceReadyTemplate : field === 'metaTemplateReceipt' ? form.whatsappReceiptTemplate : field === 'metaTemplateReminder' ? form.whatsappReminderTemplate : form.whatsappWarningTemplate;
        const sourceFields = text?.match(/\{[a-z_]+\}/gi)?.length ?? 0;
        const modelSlots = chosen ? Array.from(chosen.body.matchAll(/\{\{([^{}]+)\}\}/g), (match) => match[1]) : [];
        const modelFields = modelSlots.length;
        const invalidSequence = modelSlots.some((slot, index) => slot !== String(index + 1));
        const differentText = Boolean(chosen && numberMetaVariables(text) !== chosen.body.replace(/\r\n/g, '\n').trim());
        return <div key={field} className="meta-template-field">
          <Select label={label} value={selected} onChange={(event) => onUpdate(field, event.target.value)}>
            <option value="">Sem modelo — texto livre</option>
            {selected && !chosen && <option value={selected}>{selected} (consulte para verificar)</option>}
            {models.map((model) => <option key={`${model.name}|${model.language}`} value={`${model.name}|${model.language}`}>{model.name} · {model.language}</option>)}
          </Select>
          {chosen && <p className="meta-template-body">{chosen.body}</p>}
          {chosen && (invalidSequence || (text !== null && sourceFields !== modelFields)) && <Message tone="error">Os campos não correspondem ou não estão numerados pela ordem. O aviso não será enviado até corrigir.</Message>}
          {chosen && !invalidSequence && sourceFields === modelFields && differentText && <Message tone="error">O texto aprovado difere do texto do ISPM. O aviso não será enviado até corrigir.</Message>}
          {text !== null && <Button variant="ghost" size="sm" onClick={() => { void copyForMeta(text); }}>Copiar texto para a Meta</Button>}
        </div>;
      })}
      <Toggle
        title="Enviar avisos de atraso automaticamente"
        description="Só com consentimento dos clientes."
        checked={form.autoNoticesEnabled}
        onChange={(event) => onToggle('autoNoticesEnabled', event.target.checked)}
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
        hint="Variáveis: {nome} {codigo} {empresa} {fatura} {recibo} {servico} {valor} (2.500$00) {mes} (por extenso) {vencimento} {dias_atraso} {data_suspensao} {link}."
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
        field="whatsappReminderTemplate"
        label="Lembrete antes do vencimento"
        value={form.whatsappReminderTemplate}
        recommended={fallbackWhatsappReminderTemplate}
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
        field="whatsappWarningTemplate"
        label="Aviso de atraso prolongado"
        value={form.whatsappWarningTemplate}
        recommended={fallbackWhatsappWarningTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappSuspensionTemplate"
        label="Aviso de suspensão"
        value={form.whatsappSuspensionTemplate}
        recommended={fallbackWhatsappSuspensionTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="whatsappMaintenanceTemplate"
        label="Aviso de manutenção"
        hint="Variáveis: {data} {inicio} {fim} {motivo} {empresa}."
        value={form.whatsappMaintenanceTemplate}
        recommended={fallbackWhatsappMaintenanceTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField field="whatsappOutageTemplate" label="Aviso de avaria" value={form.whatsappOutageTemplate} recommended={fallbackWhatsappOutageTemplate} onUpdate={onUpdate} />
      <TemplateField field="whatsappRestoredTemplate" label="Serviço reposto" value={form.whatsappRestoredTemplate} recommended={fallbackWhatsappRestoredTemplate} onUpdate={onUpdate} />
    </>
  );
}

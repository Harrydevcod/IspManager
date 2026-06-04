import { Banknote, Building2, DatabaseBackup, MessageCircle, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { Button, Field, Message, Select, Textarea, Toggle } from '../components';
import { authFetch } from '../lib/auth';
import {
  fallbackWhatsappInvoiceReadyTemplate,
  fallbackWhatsappOverdueTemplate,
  fallbackWhatsappReceiptTemplate,
  fallbackWhatsappSuspensionTemplate,
  fallbackWhatsappTestTemplate,
  fallbackWhatsappTemplate,
  normalizeWhatsappPhone,
  renderWhatsappMessage,
  sendWhatsappViaUltraMsg
} from '../lib/whatsapp';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate
} from '../../shared/sms';
import type { SmsStatus } from '../types';
import { BackupsPanel } from './BackupsPanel';

type SettingsTab = 'company' | 'billing' | 'whatsapp' | 'sms' | 'backups';

const TABS: { id: SettingsTab; label: string; icon: typeof Building2 }[] = [
  { id: 'company', label: 'Empresa', icon: Building2 },
  { id: 'billing', label: 'Faturação', icon: Banknote },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'sms', label: 'SMS', icon: Smartphone },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup }
];

type SettingsFormState = {
  companyName: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  island: string;
  defaultDueDay: string;
  currencyCode: string;
  invoicePrefix: string;
  receiptPrefix: string;
  ivaRate: string;
  fiscalRegime: 'normal' | 'rempe';
  showIva: boolean;
  printQrCode: boolean;
  legalNotes: string;
  whatsappTemplate: string;
  whatsappTestTemplate: string;
  whatsappInvoiceReadyTemplate: string;
  whatsappReceiptTemplate: string;
  whatsappOverdueTemplate: string;
  whatsappSuspensionTemplate: string;
  whatsappSuspensionNoticeDays: string;
  autoNoticesEnabled: boolean;
  noticeCooldownDays: string;
  ultraMsgInstanceId: string;
  ultraMsgToken: string;
  smsCompanionEnabled: boolean;
  smsCompanionBaseUrl: string;
  smsDispatchIntervalSeconds: string;
  smsRetryGraceMinutes: string;
  smsInvoiceIssuedTemplate: string;
  smsReceiptConfirmedTemplate: string;
  smsPaymentOverdueTemplate: string;
  smsSuspensionNoticeTemplate: string;
};

export function SettingsModule() {
  const [message, setMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string; placement: 'top' | 'save' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string } | null>(null);
  const [lastSavedForm, setLastSavedForm] = useState<SettingsFormState | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('company');
  const [form, setForm] = useState<SettingsFormState>({
    companyName: 'ISPM',
    nif: '',
    phone: '',
    email: '',
    address: '',
    island: '',
    defaultDueDay: '1',
    currencyCode: 'CVE',
    invoicePrefix: 'FT',
    receiptPrefix: 'RC',
    ivaRate: '15',
    fiscalRegime: 'normal',
    showIva: false,
    printQrCode: false,
    legalNotes: '',
    whatsappTemplate: fallbackWhatsappTemplate,
    whatsappTestTemplate: fallbackWhatsappTestTemplate,
    whatsappInvoiceReadyTemplate: fallbackWhatsappInvoiceReadyTemplate,
    whatsappReceiptTemplate: fallbackWhatsappReceiptTemplate,
    whatsappOverdueTemplate: fallbackWhatsappOverdueTemplate,
    whatsappSuspensionTemplate: fallbackWhatsappSuspensionTemplate,
    whatsappSuspensionNoticeDays: '15',
    autoNoticesEnabled: false,
    noticeCooldownDays: '7',
    ultraMsgInstanceId: '',
    ultraMsgToken: '',
    smsCompanionEnabled: false,
    smsCompanionBaseUrl: '',
    smsDispatchIntervalSeconds: '60',
    smsRetryGraceMinutes: '5',
    smsInvoiceIssuedTemplate: fallbackSmsInvoiceIssuedTemplate,
    smsReceiptConfirmedTemplate: fallbackSmsReceiptConfirmedTemplate,
    smsPaymentOverdueTemplate: fallbackSmsPaymentOverdueTemplate,
    smsSuspensionNoticeTemplate: fallbackSmsSuspensionNoticeTemplate
  });
  const [smsStatus, setSmsStatus] = useState<SmsStatus | null>(null);
  const [smsPairing, setSmsPairing] = useState<{ baseUrl: string; deviceName: string }>({ baseUrl: '', deviceName: '' });
  const [smsPairingBusy, setSmsPairingBusy] = useState(false);
  const [smsQrDataUrl, setSmsQrDataUrl] = useState<string>('');
  const hasUnsavedChanges = !lastSavedForm || JSON.stringify(form) !== JSON.stringify(lastSavedForm);

  function loadSmsStatus() {
    return authFetch('http://127.0.0.1:3001/api/sms/status')
      .then((response) => (response.ok ? (response.json() as Promise<SmsStatus>) : null))
      .then(setSmsStatus)
      .catch(() => setSmsStatus(null));
  }

  async function createSmsPairing() {
    setSmsPairingBusy(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(smsPairing)
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; qrPayload?: string };
      if (!response.ok) {
        setMessage({ tone: 'error', text: data.error || 'Nao foi possivel parear o Android SMS.', placement: 'top' });
        return;
      }
      setForm((current) => ({ ...current, smsCompanionEnabled: true, smsCompanionBaseUrl: smsPairing.baseUrl }));
      setMessage({ tone: 'success', text: `Pareamento gerado. Codigo de emparelhamento: ${data.qrPayload}`, placement: 'top' });
      if (data.qrPayload) {
        try {
          const url = await QRCode.toDataURL(data.qrPayload, { width: 220, margin: 1 });
          setSmsQrDataUrl(url);
        } catch {
          setSmsQrDataUrl('');
        }
      }
      await loadSmsStatus();
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao parear o Android SMS.', placement: 'top' });
    } finally {
      setSmsPairingBusy(false);
    }
  }

  async function revokeSmsPairing() {
    setSmsPairingBusy(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', { method: 'DELETE' });
      if (!response.ok) {
        setMessage({ tone: 'error', text: 'Nao foi possivel revogar o pareamento.', placement: 'top' });
        return;
      }
      setForm((current) => ({ ...current, smsCompanionEnabled: false }));
      setMessage({ tone: 'success', text: 'Pareamento Android revogado.', placement: 'top' });
      await loadSmsStatus();
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao revogar o pareamento.', placement: 'top' });
    } finally {
      setSmsPairingBusy(false);
    }
  }

  useEffect(() => {
    void loadSmsStatus();
    authFetch('http://127.0.0.1:3001/api/settings')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar configuracoes');
        }
        return response.json() as Promise<Omit<SettingsFormState, 'defaultDueDay' | 'ivaRate' | 'whatsappSuspensionNoticeDays' | 'noticeCooldownDays' | 'smsDispatchIntervalSeconds' | 'smsRetryGraceMinutes'> & { defaultDueDay: number; ivaRate: number; whatsappSuspensionNoticeDays: number; noticeCooldownDays: number; smsDispatchIntervalSeconds: number; smsRetryGraceMinutes: number }>;
      })
      .then((settings) => {
        const loadedForm = {
          ...settings,
          defaultDueDay: String(settings.defaultDueDay),
          ivaRate: String(settings.ivaRate),
          whatsappSuspensionNoticeDays: String(settings.whatsappSuspensionNoticeDays),
          noticeCooldownDays: String(settings.noticeCooldownDays),
          smsDispatchIntervalSeconds: String(settings.smsDispatchIntervalSeconds),
          smsRetryGraceMinutes: String(settings.smsRetryGraceMinutes)
        };
        setForm(loadedForm);
        setLastSavedForm(loadedForm);
        setMessage(null);
      })
      .catch((err: unknown) => {
        setMessage({
          tone: 'error',
          text: err instanceof Error ? err.message : 'Erro ao carregar configuracoes',
          placement: 'top'
        });
      });
  }, []);

  function updateForm(field: keyof SettingsFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function templateRows(value: string) {
    const explicitLines = value.split('\n').length;
    const wrappedLines = Math.ceil(value.length / 92);
    return Math.min(4, Math.max(2, explicitLines, wrappedLines));
  }

  useEffect(() => {
    if (message?.placement !== 'save' || message.tone === 'error') return;
    const timeout = window.setTimeout(() => {
      setMessage((current) => current === message ? null : current);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (!testMessage || testMessage.tone === 'error') return;
    const timeout = window.setTimeout(() => {
      setTestMessage((current) => current === testMessage ? null : current);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [testMessage]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasUnsavedChanges) {
      setMessage({ tone: 'neutral', text: 'Nao ha alteracoes por guardar.', placement: 'save' });
      return;
    }

    setSaving(true);
    setMessage({ tone: 'neutral', text: 'A gravar configuracoes...', placement: 'save' });

    try {
      const response = await authFetch('http://127.0.0.1:3001/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          defaultDueDay: Number(form.defaultDueDay),
          ivaRate: Number(form.ivaRate),
          whatsappSuspensionNoticeDays: Number(form.whatsappSuspensionNoticeDays),
          noticeCooldownDays: Number(form.noticeCooldownDays),
          smsDispatchIntervalSeconds: Number(form.smsDispatchIntervalSeconds),
          smsRetryGraceMinutes: Number(form.smsRetryGraceMinutes)
        })
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({ error: 'Nao foi possivel gravar configuracoes.' })) as { error?: string };
        setMessage({ tone: 'error', text: result.error || 'Nao foi possivel gravar configuracoes.', placement: 'save' });
        return;
      }

      setLastSavedForm(form);
      setMessage({ tone: 'success', text: 'Configuracoes gravadas com sucesso.', placement: 'save' });
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao gravar configuracoes.', placement: 'save' });
    } finally {
      setSaving(false);
    }
  }

  async function sendTestWhatsapp() {
    if (!normalizeWhatsappPhone(testPhone)) {
      setTestMessage({ tone: 'error', text: 'Indique um telefone WhatsApp valido para teste.' });
      return;
    }

    setTestSending(true);
    setTestMessage({ tone: 'neutral', text: 'A enviar mensagem de teste...' });
    try {
      const body = renderWhatsappMessage(
        form.whatsappTestTemplate,
        { fullName: 'Teste ISPM', clientCode: 'TESTE', phone: testPhone },
        form.companyName
      );
      await sendWhatsappViaUltraMsg(testPhone, body);
      setTestMessage({ tone: 'success', text: 'Mensagem de teste enviada via UltraMsg.' });
    } catch (err) {
      setTestMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Nao foi possivel enviar a mensagem de teste.'
      });
    } finally {
      setTestSending(false);
    }
  }

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Sistema</p>
          <h2>Configurações</h2>
        </div>
      </div>

      <nav className="settings-tabs" role="tablist" aria-label="Configurações por tópico">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <Button
              key={tab.id}
              variant="ghost"
              role="tab"
              aria-selected={active}
              className={`settings-tab${active ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={14} aria-hidden />
              <span>{tab.label}</span>
            </Button>
          );
        })}
      </nav>

      {message && message.placement === 'top' && <Message tone={message.tone}>{message.text}</Message>}

      {activeTab !== 'backups' && (
      <form className="client-form settings-form" onSubmit={saveSettings}>
        {activeTab === 'company' && (
          <>
            <Field
              label="Nome da empresa"
              required
              value={form.companyName}
              onChange={(event) => updateForm('companyName', event.target.value)}
            />
            <Field
              label="NIF"
              value={form.nif}
              onChange={(event) => updateForm('nif', event.target.value)}
            />
            <Field
              label="Telefone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={form.phone}
              onChange={(event) => updateForm('phone', event.target.value)}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              value={form.email}
              onChange={(event) => updateForm('email', event.target.value)}
            />
            <Field
              label="Ilha"
              value={form.island}
              onChange={(event) => updateForm('island', event.target.value)}
            />
            <Field
              wide
              label="Morada"
              value={form.address}
              onChange={(event) => updateForm('address', event.target.value)}
            />
          </>
        )}

        {activeTab === 'billing' && (
          <>
            <Field
              label="Dia padrão de vencimento"
              required
              type="number"
              min={1}
              max={31}
              value={form.defaultDueDay}
              onChange={(event) => updateForm('defaultDueDay', event.target.value)}
            />
            <Field
              label="Moeda"
              required
              value={form.currencyCode}
              onChange={(event) => updateForm('currencyCode', event.target.value)}
            />
            <Field
              label="Prefixo fatura"
              required
              value={form.invoicePrefix}
              onChange={(event) => updateForm('invoicePrefix', event.target.value)}
            />
            <Field
              label="Prefixo recibo"
              required
              value={form.receiptPrefix}
              onChange={(event) => updateForm('receiptPrefix', event.target.value)}
            />
            <Select
              label="Regime fiscal"
              value={form.fiscalRegime}
              onChange={(event) => updateForm('fiscalRegime', event.target.value as 'normal' | 'rempe')}
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
              onChange={(event) => updateForm('ivaRate', event.target.value)}
            />
            <Textarea
              label="Observações no documento"
              rows={3}
              value={form.legalNotes}
              onChange={(event) => updateForm('legalNotes', event.target.value)}
              placeholder="Texto opcional que aparece no rodapé de cada fatura/recibo (ex: termos, IBAN, agradecimento)"
            />
            <Toggle
              title="Mostrar linha de IVA nos documentos"
              description="Quando desligado, fatura/recibo mostram apenas o total (serviço informal). Liga quando estiveres com contabilidade organizada."
              checked={form.showIva}
              onChange={(event) => setForm((current) => ({ ...current, showIva: event.target.checked }))}
            />
            <Toggle
              title="Imprimir QR Code fiscal nos documentos"
              description="QR no formato Portaria 47/2021 (preparatório para e-Fatura). Liga quando estiveres preparado para credenciação na DNRE."
              checked={form.printQrCode}
              onChange={(event) => setForm((current) => ({ ...current, printQrCode: event.target.checked }))}
            />
          </>
        )}

        {activeTab === 'whatsapp' && (
          <>
            <Field
              label="UltraMsg instance ID"
              autoComplete="off"
              spellCheck={false}
              value={form.ultraMsgInstanceId}
              onChange={(event) => updateForm('ultraMsgInstanceId', event.target.value)}
              placeholder="instance00000"
            />
            <Field
              label="UltraMsg token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={form.ultraMsgToken}
              onChange={(event) => updateForm('ultraMsgToken', event.target.value)}
            />
            <Field
              label="Avisar suspensao apos X dias"
              type="number"
              min={1}
              max={120}
              value={form.whatsappSuspensionNoticeDays}
              onChange={(event) => updateForm('whatsappSuspensionNoticeDays', event.target.value)}
            />
            <Toggle
              title="Enviar avisos de atraso automaticamente"
              description="Uma vez por dia, o sistema envia avisos de atraso/suspensao aos clientes elegiveis via WhatsApp. Desligado por defeito — liga so com consentimento dos clientes e UltraMsg configurado."
              checked={form.autoNoticesEnabled}
              onChange={(event) => setForm((current) => ({ ...current, autoNoticesEnabled: event.target.checked }))}
            />
            <Field
              label="Nao repetir o mesmo aviso durante X dias"
              type="number"
              min={1}
              max={90}
              value={form.noticeCooldownDays}
              onChange={(event) => updateForm('noticeCooldownDays', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="Mensagem de teste"
              rows={templateRows(form.whatsappTestTemplate)}
              value={form.whatsappTestTemplate}
              onChange={(event) => updateForm('whatsappTestTemplate', event.target.value)}
            />
            <Field
              label="Telefone para teste"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={testPhone}
              onChange={(event) => setTestPhone(event.target.value)}
              placeholder="9910000 ou 2389910000"
            />
            <div className="settings-test-whatsapp" aria-label="Enviar mensagem de teste">
              <span>Envio de teste</span>
              {testMessage && <Message tone={testMessage.tone}>{testMessage.text}</Message>}
              <Button
                variant="secondary"
                onClick={() => void sendTestWhatsapp()}
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
              onChange={(event) => updateForm('whatsappTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="Fatura do mes pronta"
              rows={templateRows(form.whatsappInvoiceReadyTemplate)}
              value={form.whatsappInvoiceReadyTemplate}
              onChange={(event) => updateForm('whatsappInvoiceReadyTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="Confirmacao de recebimento e recibo"
              rows={templateRows(form.whatsappReceiptTemplate)}
              value={form.whatsappReceiptTemplate}
              onChange={(event) => updateForm('whatsappReceiptTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="Fatura em atraso"
              rows={templateRows(form.whatsappOverdueTemplate)}
              value={form.whatsappOverdueTemplate}
              onChange={(event) => updateForm('whatsappOverdueTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="Aviso de corte/suspensao"
              rows={templateRows(form.whatsappSuspensionTemplate)}
              value={form.whatsappSuspensionTemplate}
              onChange={(event) => updateForm('whatsappSuspensionTemplate', event.target.value)}
            />
          </>
        )}

        {activeTab === 'sms' && (
          <>
            <Toggle
              title="Ativar SMS via Android"
              description="O desktop enfileira os SMS e o telemovel Android pareado pede aprovacao antes de enviar pelo cartao SIM. Ideal como canal de reforco quando o cliente nao tem WhatsApp."
              checked={form.smsCompanionEnabled}
              onChange={(event) => setForm((current) => ({ ...current, smsCompanionEnabled: event.target.checked }))}
            />
            <div className="settings-test-whatsapp" aria-label="Pareamento do Android SMS">
              <span>{smsStatus?.paired ? `Pareado${smsStatus.deviceName ? `: ${smsStatus.deviceName}` : ''}${smsStatus.baseUrl ? ` (${smsStatus.baseUrl})` : ''}` : 'Android nao pareado'}</span>
              <Field
                label="Endereco do Android na rede local"
                value={smsPairing.baseUrl}
                onChange={(event) => setSmsPairing((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="http://192.168.1.50:8765"
              />
              <Field
                label="Nome do dispositivo"
                value={smsPairing.deviceName}
                onChange={(event) => setSmsPairing((current) => ({ ...current, deviceName: event.target.value }))}
                placeholder="Telemovel da loja"
              />
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() => void createSmsPairing()}
                  disabled={!smsPairing.baseUrl || !smsPairing.deviceName}
                  loading={smsPairingBusy}
                >
                  {smsStatus?.paired ? 'Gerar novo pareamento' : 'Gerar pareamento'}
                </Button>
                {smsStatus?.paired && (
                  <Button variant="ghost" onClick={() => void revokeSmsPairing()} disabled={smsPairingBusy}>
                    Revogar
                  </Button>
                )}
              </div>
              {smsQrDataUrl && (
                <div className="sms-pairing-qr">
                  <img src={smsQrDataUrl} alt="QR Code de pareamento do Android SMS" width={220} height={220} />
                  <span>Lê este QR no app ISPM SMS do telemóvel para parear.</span>
                </div>
              )}
            </div>
            {smsStatus && (
              <Message tone={smsStatus.counts.failed > 0 ? 'error' : 'neutral'}>
                Fila SMS: {smsStatus.counts.pendingDispatch} por entregar, {smsStatus.counts.pendingApproval} a aguardar aprovacao no Android, {smsStatus.counts.failed} falhado(s).
              </Message>
            )}
            <Field
              label="Intervalo de envio SMS (segundos)"
              type="number"
              min={15}
              max={3600}
              value={form.smsDispatchIntervalSeconds}
              onChange={(event) => updateForm('smsDispatchIntervalSeconds', event.target.value)}
            />
            <Field
              label="Reenvio apos falha (minutos)"
              type="number"
              min={1}
              max={1440}
              value={form.smsRetryGraceMinutes}
              onChange={(event) => updateForm('smsRetryGraceMinutes', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="SMS — emissao de fatura"
              rows={templateRows(form.smsInvoiceIssuedTemplate)}
              value={form.smsInvoiceIssuedTemplate}
              onChange={(event) => updateForm('smsInvoiceIssuedTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="SMS — confirmacao de recibo"
              rows={templateRows(form.smsReceiptConfirmedTemplate)}
              value={form.smsReceiptConfirmedTemplate}
              onChange={(event) => updateForm('smsReceiptConfirmedTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="SMS — atraso de pagamento"
              rows={templateRows(form.smsPaymentOverdueTemplate)}
              value={form.smsPaymentOverdueTemplate}
              onChange={(event) => updateForm('smsPaymentOverdueTemplate', event.target.value)}
            />
            <Textarea
              className="whatsapp-template-field"
              label="SMS — aviso de suspensao"
              rows={templateRows(form.smsSuspensionNoticeTemplate)}
              value={form.smsSuspensionNoticeTemplate}
              onChange={(event) => updateForm('smsSuspensionNoticeTemplate', event.target.value)}
            />
          </>
        )}

        <div className="form-actions">
          {message && message.placement === 'save' && (
            <Message tone={message.tone}>{message.text}</Message>
          )}
          <Button type="submit" variant="primary" loading={saving}>
            {saving
              ? 'A gravar...'
              : !hasUnsavedChanges
                ? 'Alterar configurações'
                : 'Guardar alterações'}
          </Button>
        </div>
      </form>
      )}

      {activeTab === 'backups' && <BackupsPanel />}
    </section>
  );
}

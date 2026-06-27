import { Banknote, Building2, DatabaseBackup, MessageCircle, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button, Message } from '../components';
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
import { BillingTab } from './settings/BillingTab';
import { CompanyTab } from './settings/CompanyTab';
import { SmsTab } from './settings/SmsTab';
import { WhatsappTab } from './settings/WhatsappTab';
import { emptyBankAccount, type BankAccountForm, type SettingsFormState } from './settings/settingsForm';

type SettingsTab = 'company' | 'billing' | 'whatsapp' | 'sms' | 'backups';

const TABS: { id: SettingsTab; label: string; icon: typeof Building2 }[] = [
  { id: 'company', label: 'Empresa', icon: Building2 },
  { id: 'billing', label: 'Faturação', icon: Banknote },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'sms', label: 'SMS', icon: Smartphone },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup }
];

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
    bankAccounts: [],
    defaultDueDay: '1',
    autoBillingDay: '30',
    audiovisualEnabled: false,
    audiovisualLabel: 'Distribuição de Conteúdos Audiovisuais',
    audiovisualMonthlyCve: '500',
    audiovisualAnnualCve: '5000',
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
  const [smsVerifying, setSmsVerifying] = useState(false);
  const pairingPollRef = useRef<{ cancelled: boolean } | null>(null);
  const hasUnsavedChanges = !lastSavedForm || JSON.stringify(form) !== JSON.stringify(lastSavedForm);

  function stopPairingVerification() {
    if (pairingPollRef.current) pairingPollRef.current.cancelled = true;
    pairingPollRef.current = null;
    setSmsVerifying(false);
  }

  // Polls the phone after a QR is shown: confirms it scanned the code (signature
  // accepted) before declaring success, closes the QR, and surfaces a clear
  // success/failure message. Keeps the QR open on failure so the user can retry.
  async function startPairingVerification(deviceName: string) {
    if (pairingPollRef.current) pairingPollRef.current.cancelled = true;
    const token = { cancelled: false };
    pairingPollRef.current = token;
    setSmsVerifying(true);
    const deadline = Date.now() + 60_000;
    try {
      while (!token.cancelled && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (token.cancelled) return;
        try {
          const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing/verify');
          const data = (await response.json().catch(() => ({}))) as { reachable?: boolean; paired?: boolean; deviceName?: string };
          if (token.cancelled) return;
          if (data.paired) {
            setSmsQrDataUrl('');
            setMessage({ tone: 'success', text: `Telemovel "${data.deviceName || deviceName}" pareado com sucesso.`, placement: 'top' });
            await loadSmsStatus();
            return;
          }
        } catch {
          // Phone not reachable yet — keep polling until the deadline.
        }
      }
      if (!token.cancelled) {
        setMessage({
          tone: 'error',
          text: 'Nao foi possivel confirmar o pareamento. Confirma que o telemovel esta na mesma rede Wi-Fi, que o endereco esta correto e que leu o QR Code. Tenta novamente.',
          placement: 'top'
        });
      }
    } finally {
      if (pairingPollRef.current === token) pairingPollRef.current = null;
      setSmsVerifying(false);
    }
  }

  function loadSmsStatus() {
    return authFetch('http://127.0.0.1:3001/api/sms/status')
      .then((response) => (response.ok ? (response.json() as Promise<SmsStatus>) : null))
      .then((data) => {
        setSmsStatus(data);
        // Hydrate the pairing form from the persisted settings so the IP and
        // device name survive reloads. Keep anything the operator is mid-typing.
        if (data) {
          setSmsPairing((current) => ({
            baseUrl: current.baseUrl || data.baseUrl || '',
            deviceName: current.deviceName || data.deviceName || ''
          }));
        }
      })
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
      setMessage({ tone: 'neutral', text: 'QR Code gerado. Le-o no telemovel — a aguardar confirmacao do pareamento...', placement: 'top' });
      if (data.qrPayload) {
        try {
          const url = await QRCode.toDataURL(data.qrPayload, { width: 220, margin: 1 });
          setSmsQrDataUrl(url);
        } catch {
          setSmsQrDataUrl('');
        }
      }
      await loadSmsStatus();
      void startPairingVerification(smsPairing.deviceName);
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao parear o Android SMS.', placement: 'top' });
    } finally {
      setSmsPairingBusy(false);
    }
  }

  async function revokeSmsPairing() {
    setSmsPairingBusy(true);
    stopPairingVerification();
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', { method: 'DELETE' });
      if (!response.ok) {
        setMessage({ tone: 'error', text: 'Nao foi possivel revogar o pareamento.', placement: 'top' });
        return;
      }
      setForm((current) => ({ ...current, smsCompanionEnabled: false }));
      setSmsQrDataUrl('');
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
        return response.json() as Promise<Omit<SettingsFormState, 'defaultDueDay' | 'autoBillingDay' | 'audiovisualMonthlyCve' | 'audiovisualAnnualCve' | 'ivaRate' | 'whatsappSuspensionNoticeDays' | 'noticeCooldownDays' | 'smsDispatchIntervalSeconds' | 'smsRetryGraceMinutes'> & { defaultDueDay: number; autoBillingDay: number; audiovisualMonthlyCve: number; audiovisualAnnualCve: number; ivaRate: number; whatsappSuspensionNoticeDays: number; noticeCooldownDays: number; smsDispatchIntervalSeconds: number; smsRetryGraceMinutes: number }>;
      })
      .then((settings) => {
        const loadedForm = {
          ...settings,
          bankAccounts: Array.isArray(settings.bankAccounts) ? settings.bankAccounts : [],
          defaultDueDay: String(settings.defaultDueDay),
          autoBillingDay: String(settings.autoBillingDay),
          audiovisualMonthlyCve: String(settings.audiovisualMonthlyCve),
          audiovisualAnnualCve: String(settings.audiovisualAnnualCve),
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

  useEffect(() => () => {
    if (pairingPollRef.current) pairingPollRef.current.cancelled = true;
  }, []);

  function updateForm(field: keyof SettingsFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function toggleForm(field: keyof SettingsFormState, value: boolean) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function addBankAccount() {
    setForm((current) => ({
      ...current,
      bankAccounts: current.bankAccounts.length >= 8
        ? current.bankAccounts
        : [...current.bankAccounts, { ...emptyBankAccount }]
    }));
  }

  function updateBankAccount(index: number, field: keyof BankAccountForm, value: string) {
    setForm((current) => ({
      ...current,
      bankAccounts: current.bankAccounts.map((account, accountIndex) => (
        accountIndex === index ? { ...account, [field]: value } : account
      ))
    }));
  }

  function removeBankAccount(index: number) {
    setForm((current) => ({
      ...current,
      bankAccounts: current.bankAccounts.filter((_, accountIndex) => accountIndex !== index)
    }));
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
      const normalizedBankAccounts = form.bankAccounts
        .map((account) => ({
          bankName: account.bankName.trim(),
          accountName: account.accountName.trim(),
          accountNumber: account.accountNumber.trim(),
          reference: account.reference.trim()
        }))
        .filter((account) => account.bankName || account.accountName || account.accountNumber || account.reference);
      const savedForm = { ...form, bankAccounts: normalizedBankAccounts };
      const response = await authFetch('http://127.0.0.1:3001/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...savedForm,
          defaultDueDay: Number(savedForm.defaultDueDay),
          autoBillingDay: Number(savedForm.autoBillingDay),
          audiovisualMonthlyCve: Number(savedForm.audiovisualMonthlyCve),
          audiovisualAnnualCve: Number(savedForm.audiovisualAnnualCve),
          ivaRate: Number(savedForm.ivaRate),
          whatsappSuspensionNoticeDays: Number(savedForm.whatsappSuspensionNoticeDays),
          noticeCooldownDays: Number(savedForm.noticeCooldownDays),
          smsDispatchIntervalSeconds: Number(savedForm.smsDispatchIntervalSeconds),
          smsRetryGraceMinutes: Number(savedForm.smsRetryGraceMinutes)
        })
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({ error: 'Nao foi possivel gravar configuracoes.' })) as { error?: string };
        setMessage({ tone: 'error', text: result.error || 'Nao foi possivel gravar configuracoes.', placement: 'save' });
        return;
      }

      setForm(savedForm);
      setLastSavedForm(savedForm);
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
          <CompanyTab
            form={form}
            onUpdate={updateForm}
            onAddBankAccount={addBankAccount}
            onUpdateBankAccount={updateBankAccount}
            onRemoveBankAccount={removeBankAccount}
          />
        )}

        {activeTab === 'billing' && (
          <BillingTab form={form} onUpdate={updateForm} onToggle={toggleForm} />
        )}

        {activeTab === 'whatsapp' && (
          <WhatsappTab
            form={form}
            onUpdate={updateForm}
            onToggle={toggleForm}
            testPhone={testPhone}
            onTestPhoneChange={setTestPhone}
            testMessage={testMessage}
            testSending={testSending}
            onSendTest={() => void sendTestWhatsapp()}
          />
        )}

        {activeTab === 'sms' && (
          <SmsTab
            form={form}
            onUpdate={updateForm}
            onToggle={toggleForm}
            smsStatus={smsStatus}
            smsPairing={smsPairing}
            onPairingChange={(field, value) => setSmsPairing((current) => ({ ...current, [field]: value }))}
            smsVerifying={smsVerifying}
            smsPairingBusy={smsPairingBusy}
            smsQrDataUrl={smsQrDataUrl}
            onCreatePairing={() => void createSmsPairing()}
            onRevokePairing={() => void revokeSmsPairing()}
          />
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

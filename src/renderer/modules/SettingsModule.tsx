import { Activity, Banknote, Building2, CreditCard, DatabaseBackup, Gauge, KeyRound, MessageCircle, Radar, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button, Message, TabList, type SecretDraft } from '../components';
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
  sendWhatsapp
} from '../lib/whatsapp';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate
} from '../../shared/sms';
import { currentSmsReportMonth } from '../../shared/sms-report';
import type { SmsMonthlyReport, SmsStatus } from '../types';
import { BackupsPanel } from './BackupsPanel';
import { BillingTab } from './settings/BillingTab';
import { CompanyTab } from './settings/CompanyTab';
import { SmsTab, type SmsPairingScreen } from './settings/SmsTab';
import { WhatsappTab } from './settings/WhatsappTab';
import { PaymentTab } from './settings/PaymentTab';
import type { SettingsFormState } from './settings/settingsForm';
import { NetworkTab, type RouterEnforcementState, type RouterTestReport } from './settings/NetworkTab';
import { RouterLiveDialog } from './settings/RouterLiveDialog';
import { AdminPasswordDialog } from './settings/AdminPasswordDialog';
import { ErrorReportsPanel } from './ErrorReportsPanel';
import { JobHealthPanel } from './JobHealthPanel';
import { LicensePanel } from './LicensePanel';
import { VaultPanel } from './settings/VaultPanel';
import { FupSettingsPanel } from './settings/FupSettingsPanel';
import { useAuth } from '../lib/auth';

type SettingsTab = 'company' | 'billing' | 'payments' | 'whatsapp' | 'sms' | 'network' | 'fup' | 'backups' | 'jobs' | 'license' | 'vault';

const TABS: { id: SettingsTab; label: string; icon: typeof Building2 }[] = [
  { id: 'company', label: 'Empresa', icon: Building2 },
  { id: 'billing', label: 'Faturação', icon: Banknote },
  { id: 'payments', label: 'Pagamento', icon: CreditCard },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'sms', label: 'SMS', icon: Smartphone },
  { id: 'network', label: 'Rede', icon: Radar },
  { id: 'fup', label: 'Uso justo', icon: Gauge },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup },
  { id: 'jobs', label: 'Automatismos', icon: Activity },
  { id: 'license', label: 'Licença', icon: KeyRound },
  { id: 'vault', label: 'Cofre', icon: KeyRound }
];

/**
 * Folga sobre o servidor, que gasta no máximo 10 s a chegar à porta e outros
 * 10 s na REST. Só dispara quando nem o backend responde.
 */
const ROUTER_TEST_TIMEOUT_MS = 30_000;

/** Aviso local no mesmo painel do diagnóstico, sem etapas nenhumas. */
function routerNote(summary: string, tone: 'neutral' | 'error'): RouterTestReport {
  return { ok: false, steps: [], summary, tone };
}

type SettingsModuleProps = {
  /**
   * `router`: só a configuração do router de gestão, embutida no módulo Router
   * de gestão. É o mesmo formulário e a mesma gravação — incluindo o passo a
   * mais para sair do ensaio (RouterLiveDialog) — e não uma segunda porta.
   */
  scope?: 'all' | 'router';
  /** Separador a abrir quando se chega de fora (o aviso do cofre abre o Cofre). */
  initialTab?: 'vault';
};

export function SettingsModule({ scope = 'all', initialTab }: SettingsModuleProps = {}) {
  const auth = useAuth();
  const [routerSecretDraft, setRouterSecretDraft] = useState<SecretDraft>({ editing: false });
  const [ultraSecretDraft, setUltraSecretDraft] = useState<SecretDraft>({ editing: false });
  const [metaSecretDraft, setMetaSecretDraft] = useState<SecretDraft>({ editing: false });
  const [stripeSecretDraft, setStripeSecretDraft] = useState<SecretDraft>({ editing: false });
  const [message, setMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string; placement: 'top' | 'save' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string } | null>(null);
  const [lastSavedForm, setLastSavedForm] = useState<SettingsFormState | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(scope === 'router' ? 'network' : initialTab ?? 'company');
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
    installationFeeCve: '0',
    currencyCode: 'CVE',
    invoicePrefix: 'FT',
    receiptPrefix: 'RC',
    ivaRate: '15',
    fiscalRegime: 'normal',
    showIva: false,
    printQrCode: false,
    printRentalLines: false,
    legalNotes: '',
    productPolicy: '',
    whatsappTemplate: fallbackWhatsappTemplate,
    whatsappTestTemplate: fallbackWhatsappTestTemplate,
    whatsappInvoiceReadyTemplate: fallbackWhatsappInvoiceReadyTemplate,
    whatsappReceiptTemplate: fallbackWhatsappReceiptTemplate,
    whatsappOverdueTemplate: fallbackWhatsappOverdueTemplate,
    whatsappSuspensionTemplate: fallbackWhatsappSuspensionTemplate,
    whatsappChannelEnabled: true,
    autoNoticesEnabled: false,
    noticeCooldownDays: '7',
    ultraMsgInstanceId: '',
    ultraMsgToken: '',
    whatsappProvider: 'ultramsg',
    metaPhoneNumberId: '',
    metaAccessToken: '',
    smsCompanionEnabled: false,
    smsAutoNoticesEnabled: false,
    smsCompanionBaseUrl: '',
    smsDispatchIntervalSeconds: '60',
    smsRetryGraceMinutes: '5',
    smsInvoiceIssuedTemplate: fallbackSmsInvoiceIssuedTemplate,
    smsReceiptConfirmedTemplate: fallbackSmsReceiptConfirmedTemplate,
    smsPaymentOverdueTemplate: fallbackSmsPaymentOverdueTemplate,
    smsSuspensionNoticeTemplate: fallbackSmsSuspensionNoticeTemplate,
    networkProbeEnabled: false,
    networkProbeIntervalSeconds: '60',
    networkProbeIncludeClients: false,
    networkProbeFailThreshold: '3',
    routerosEnabled: false,
    routerosHost: '',
    routerosPort: '443',
    routerosUser: '',
    routerosPassword: '',
    routerosTlsCert: '',
    routerosDryRun: true,
    routerosIntervalSeconds: '120',
    routerosMaxDisablesPerRun: '5',
    routerosBaseProfile: 'default',
    routerosPppLocalAddress: '',
    routerosPppRemotePool: '',
    routerosPppInterfaceList: 'PPPOE',
    routerosPppDns: '',
    routerosPppParentQueue: '',
    routerosSuspendedProfile: 'SUSPENSO',
    routerosPppoePrefix: '',
    iptvVpnSplitList: 'IPTV-SPLIT',
    iptvVpnServersList: 'IPTV-SERVERS',
    autoSuspensionEnabled: false,
    autoSuspensionGraceDays: '15',
    autoSuspensionIntervalMinutes: '60',
    autoSuspensionMaxPerRun: '5',
    autoSuspensionMaxPercent: '20',
    stripeEnabled: false,
    stripeSecretKey: '',
    stripeTreasuryAccountId: '',
    vinti4Enabled: false,
    vinti4TreasuryAccountId: ''
  });
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeMessage, setProbeMessage] = useState('');
  /** Credenciais que o arranque não conseguiu abrir: base vinda de outra conta. */
  const [secretsLost, setSecretsLost] = useState<string[]>([]);
  const [routerBusy, setRouterBusy] = useState(false);
  const [routerReport, setRouterReport] = useState<RouterTestReport | null>(null);
  const [routerCert, setRouterCert] = useState<{ pem: string; fingerprint: string } | null>(null);
  const [routerState, setRouterState] = useState<RouterEnforcementState | null>(null);
  const [enforceBusy, setEnforceBusy] = useState(false);
  const [enforceMessage, setEnforceMessage] = useState('');
  const [autoSuspendBusy, setAutoSuspendBusy] = useState(false);
  const [autoSuspendMessage, setAutoSuspendMessage] = useState('');
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  // Ligar a app móvel (pelo interruptor ou ao parear) pede a password do admin.
  const [smsPasswordFor, setSmsPasswordFor] = useState<'enable' | 'pair' | null>(null);
  const [smsPasswordError, setSmsPasswordError] = useState<string | null>(null);
  const [smsStatus, setSmsStatus] = useState<SmsStatus | null>(null);
  const [smsReportMonth, setSmsReportMonth] = useState(currentSmsReportMonth);
  const [smsReport, setSmsReport] = useState<SmsMonthlyReport | null>(null);
  const [smsReportLoading, setSmsReportLoading] = useState(false);
  const [smsPairingBusy, setSmsPairingBusy] = useState(false);
  const [smsDetecting, setSmsDetecting] = useState(false);
  const [smsSyncing, setSmsSyncing] = useState(false);
  const [smsSession, setSmsSession] = useState<SmsPairingScreen | null>(null);
  const pairingPollRef = useRef<{ cancelled: boolean } | null>(null);
  const smsReportRequestRef = useRef(0);
  const hasUnsavedChanges = !lastSavedForm || JSON.stringify(form) !== JSON.stringify(lastSavedForm);

  function stopPairingPoll() {
    if (pairingPollRef.current) pairingPollRef.current.cancelled = true;
    pairingPollRef.current = null;
  }

  // Pareamento v2: o servidor procura na rede o telemóvel que leu o QR; aqui só
  // se pergunta pelo estado até aparecer o código, expirar ou alguém cancelar.
  async function showPairingQr(qrPayload: string) {
    stopPairingPoll();
    const token = { cancelled: false };
    pairingPollRef.current = token;
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 220, margin: 1 }).catch(() => '');
    if (token.cancelled) return;
    setSmsSession({ state: 'waiting', qrDataUrl });
    while (!token.cancelled) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
      if (token.cancelled) return;
      const data = await authFetch('http://127.0.0.1:3001/api/sms/pairing/session')
        .then((response) => response.json() as Promise<{ state?: string; sas?: string; model?: string }>)
        .catch(() => null);
      if (token.cancelled) return;
      if (!data) continue;
      if (data.state === 'idle') {
        setSmsSession(null);
        break;
      }
      if (data.state === 'found' || data.state === 'expired') {
        setSmsSession({ state: data.state, qrDataUrl, sas: data.sas, model: data.model });
        break;
      }
    }
    if (pairingPollRef.current === token) pairingPollRef.current = null;
  }

  async function renewSmsPairing() {
    setSmsPairingBusy(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing/renew', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { error?: string; qrPayload?: string };
      if (!response.ok || !data.qrPayload) {
        setSmsSession(null);
        setMessage({ tone: 'error', text: data.error || 'Nao foi possivel gerar um QR novo.', placement: 'top' });
        return;
      }
      void showPairingQr(data.qrPayload);
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao gerar um QR novo.', placement: 'top' });
    } finally {
      setSmsPairingBusy(false);
    }
  }

  async function confirmSmsPairing() {
    setSmsPairingBusy(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing/confirm', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { error?: string; baseUrl?: string; deviceName?: string };
      if (!response.ok) {
        setMessage({ tone: 'error', text: data.error || 'Nao foi possivel confirmar o pareamento.', placement: 'top' });
        return;
      }
      // O servidor já gravou a ligação ligada: não fica como alteração por guardar.
      const paired = (current: SettingsFormState) => ({ ...current, smsCompanionEnabled: true, smsCompanionBaseUrl: data.baseUrl || '' });
      setForm(paired);
      setLastSavedForm((current) => (current ? paired(current) : current));
      setSmsSession(null);
      setMessage({ tone: 'success', text: `${data.deviceName || 'Telemóvel'} pareado.`, placement: 'top' });
      await loadSmsStatus();
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao confirmar o pareamento.', placement: 'top' });
    } finally {
      setSmsPairingBusy(false);
    }
  }

  async function cancelSmsPairing() {
    stopPairingPoll();
    setSmsSession(null);
    await authFetch('http://127.0.0.1:3001/api/sms/pairing/session', { method: 'DELETE' }).catch(() => null);
  }

  function loadSmsStatus() {
    return authFetch('http://127.0.0.1:3001/api/sms/status')
      .then((response) => (response.ok ? (response.json() as Promise<SmsStatus>) : null))
      .then((data) => {
        setSmsStatus(data);
      })
      .catch(() => setSmsStatus(null));
  }

  async function loadSmsReport(month: string) {
    const requestId = ++smsReportRequestRef.current;
    setSmsReportLoading(true);
    setSmsReport(null);
    try {
      const response = await authFetch(
        `http://127.0.0.1:3001/api/sms/report?month=${encodeURIComponent(month)}`
      );
      const data = (await response.json().catch(() => ({}))) as SmsMonthlyReport | { error?: string };
      if (requestId !== smsReportRequestRef.current) return;
      if (!response.ok || !('counts' in data)) {
        throw new Error(
          'error' in data && data.error
            ? data.error
            : 'Não foi possível carregar o relatório SMS.'
        );
      }
      setSmsReport(data);
    } catch (error) {
      if (requestId !== smsReportRequestRef.current) return;
      setSmsReport(null);
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Não foi possível carregar o relatório SMS.',
        placement: 'top'
      });
    } finally {
      if (requestId === smsReportRequestRef.current) {
        setSmsReportLoading(false);
      }
    }
  }

  // Com êxito a linha de presença já diz "resumo entregue há 0 s"; só a falha precisa de mensagem.
  async function syncSmsNow() {
    setSmsSyncing(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/sync', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { online?: boolean; pushed?: boolean; lastPush?: { reason: string | null } | null; error?: string };
      if (!response.ok) {
        setMessage({ tone: 'error', text: data.error ?? 'Não foi possível sincronizar.', placement: 'top' });
      } else if (!data.online) {
        setMessage({ tone: 'error', text: 'O telemóvel não respondeu.', placement: 'top' });
      } else if (!data.pushed) {
        setMessage({ tone: 'error', text: `O resumo não chegou ao telemóvel: ${data.lastPush?.reason ?? 'sem motivo'}.`, placement: 'top' });
      }
      await loadSmsStatus();
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao sincronizar.', placement: 'top' });
    } finally {
      setSmsSyncing(false);
    }
  }

  async function detectSmsPhone() {
    setSmsDetecting(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/discover', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { baseUrl?: string | null; candidates?: string[]; paired?: boolean; updated?: boolean };
      if (!response.ok) {
        setMessage({ tone: 'error', text: 'Nao foi possivel procurar o telemovel na rede.', placement: 'top' });
        return;
      }
      if (data.paired && data.baseUrl) {
        // O servidor reconheceu o telemóvel pelo segredo e já gravou o endereço.
        setMessage({
          tone: 'success',
          text: data.updated
            ? `Telemóvel pareado encontrado em ${data.baseUrl}. Endereço atualizado — não é preciso parear de novo.`
            : `Telemóvel pareado encontrado em ${data.baseUrl}.`,
          placement: 'top'
        });
        await loadSmsStatus();
      } else {
        setMessage({ tone: 'error', text: 'O telemóvel pareado não está na rede local. Confirme que a app ISPM SMS está aberta e no mesmo Wi-Fi.', placement: 'top' });
      }
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao procurar o telemovel.', placement: 'top' });
    } finally {
      setSmsDetecting(false);
    }
  }

  /** Devolve `null` se o QR abriu, ou a mensagem de erro (para o diálogo da password). */
  async function createSmsPairing(confirmPassword: string): Promise<string | null> {
    setSmsPairingBusy(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPassword })
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; qrPayload?: string };
      if (!response.ok || !data.qrPayload) {
        return data.error || 'Nao foi possivel parear o Android SMS.';
      }
      void showPairingQr(data.qrPayload);
      return null;
    } catch {
      return 'Falha de rede ao parear o Android SMS.';
    } finally {
      setSmsPairingBusy(false);
    }
  }

  async function revokeSmsPairing() {
    setSmsPairingBusy(true);
    stopPairingPoll();
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing', { method: 'DELETE' });
      if (!response.ok) {
        setMessage({ tone: 'error', text: 'Nao foi possivel revogar o pareamento.', placement: 'top' });
        return;
      }
      setForm((current) => ({ ...current, smsCompanionEnabled: false }));
      setLastSavedForm((current) => (current ? { ...current, smsCompanionEnabled: false } : current));
      setSmsSession(null);
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
        return response.json() as Promise<Omit<SettingsFormState, 'defaultDueDay' | 'autoBillingDay' | 'audiovisualMonthlyCve' | 'audiovisualAnnualCve' | 'installationFeeCve' | 'ivaRate' | 'noticeCooldownDays' | 'smsDispatchIntervalSeconds' | 'smsRetryGraceMinutes' | 'networkProbeIntervalSeconds' | 'networkProbeFailThreshold' | 'routerosPort' | 'routerosIntervalSeconds' | 'routerosMaxDisablesPerRun' | 'autoSuspensionGraceDays' | 'autoSuspensionIntervalMinutes' | 'autoSuspensionMaxPerRun' | 'autoSuspensionMaxPercent' | 'stripeTreasuryAccountId' | 'vinti4TreasuryAccountId'> & { stripeTreasuryAccountId: number; vinti4TreasuryAccountId: number; defaultDueDay: number; autoBillingDay: number; audiovisualMonthlyCve: number; audiovisualAnnualCve: number; installationFeeCve: number; ivaRate: number; noticeCooldownDays: number; smsDispatchIntervalSeconds: number; smsRetryGraceMinutes: number; networkProbeIntervalSeconds: number; networkProbeFailThreshold: number; routerosPort: number; routerosIntervalSeconds: number; routerosMaxDisablesPerRun: number; autoSuspensionGraceDays: number; autoSuspensionIntervalMinutes: number; autoSuspensionMaxPerRun: number; autoSuspensionMaxPercent: number; secretsLost?: string[] }>;
      })
      .then((settings) => {
        const loadedForm = {
          ...settings,
          bankAccounts: Array.isArray(settings.bankAccounts) ? settings.bankAccounts : [],
          defaultDueDay: String(settings.defaultDueDay),
          autoBillingDay: String(settings.autoBillingDay),
          audiovisualMonthlyCve: String(settings.audiovisualMonthlyCve),
          audiovisualAnnualCve: String(settings.audiovisualAnnualCve),
          installationFeeCve: String(settings.installationFeeCve),
          ivaRate: String(settings.ivaRate),
          noticeCooldownDays: String(settings.noticeCooldownDays),
          smsDispatchIntervalSeconds: String(settings.smsDispatchIntervalSeconds),
          smsRetryGraceMinutes: String(settings.smsRetryGraceMinutes),
          networkProbeIntervalSeconds: String(settings.networkProbeIntervalSeconds),
          networkProbeFailThreshold: String(settings.networkProbeFailThreshold),
          routerosPort: String(settings.routerosPort),
          routerosIntervalSeconds: String(settings.routerosIntervalSeconds),
          routerosMaxDisablesPerRun: String(settings.routerosMaxDisablesPerRun),
          autoSuspensionGraceDays: String(settings.autoSuspensionGraceDays),
          autoSuspensionIntervalMinutes: String(settings.autoSuspensionIntervalMinutes),
          autoSuspensionMaxPerRun: String(settings.autoSuspensionMaxPerRun),
          autoSuspensionMaxPercent: String(settings.autoSuspensionMaxPercent),
          stripeTreasuryAccountId: settings.stripeTreasuryAccountId ? String(settings.stripeTreasuryAccountId) : '',
          vinti4TreasuryAccountId: settings.vinti4TreasuryAccountId ? String(settings.vinti4TreasuryAccountId) : ''
        };
        setForm(loadedForm);
        setLastSavedForm(loadedForm);
        setSecretsLost(Array.isArray(settings.secretsLost) ? settings.secretsLost : []);
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
    smsReportRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (activeTab !== 'sms') return;
    void loadSmsStatus();
    // O estado do telemóvel muda sem ninguém tocar no ecrã (IP, app fechada):
    // enquanto o separador está aberto, volta a perguntar. A verificação do QR
    // tem o seu próprio ciclo e não precisa deste.
    const timer = window.setInterval(() => {
      if (!pairingPollRef.current) void loadSmsStatus();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'sms') void loadSmsReport(smsReportMonth);
  }, [activeTab, smsReportMonth]);

  function updateForm(field: keyof SettingsFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function toggleForm(field: keyof SettingsFormState, value: boolean) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  useEffect(() => {
    if (message?.placement !== 'save' || message.tone === 'error') return;
    const timeout = window.setTimeout(() => {
      setMessage((current) => current === message ? null : current);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  // O estado do router só se lê quando a aba Rede está aberta: não vale a pena
  // uma leitura em cada arranque das Definições.
  useEffect(() => {
    if (activeTab === 'network') void loadRouterState();
  }, [activeTab]);

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

    // Ensaio → efetivo arma cortes a sério: explica e pede a password primeiro.
    // O servidor recusa a passagem sem ela; isto é só o caminho para lha dar.
    if (lastSavedForm?.routerosDryRun && !form.routerosDryRun) {
      setLiveError(null);
      setLiveConfirmOpen(true);
      return;
    }

    if (lastSavedForm && !lastSavedForm.smsCompanionEnabled && form.smsCompanionEnabled) {
      setSmsPasswordError(null);
      setSmsPasswordFor('enable');
      return;
    }

    await persistSettings();
  }

  async function confirmSmsPassword(password: string) {
    setSmsPasswordError(null);
    const error = smsPasswordFor === 'pair' ? await createSmsPairing(password) : await persistSettings(password);
    if (error === null) setSmsPasswordFor(null);
    else setSmsPasswordError(error);
  }

  async function confirmRouterLive(password: string) {
    setLiveError(null);
    const error = await persistSettings(password);
    if (error === null) setLiveConfirmOpen(false);
    else setLiveError(error);
  }

  /** Grava o formulário. Devolve `null` se gravou, ou a mensagem de erro. */
  async function persistSettings(confirmPassword?: string): Promise<string | null> {
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
          routerosPassword: routerSecretDraft.editing && routerSecretDraft.value ? routerSecretDraft.value : undefined,
          ultraMsgToken: ultraSecretDraft.editing && ultraSecretDraft.value ? ultraSecretDraft.value : undefined,
          metaAccessToken: metaSecretDraft.editing && metaSecretDraft.value ? metaSecretDraft.value : undefined,
          stripeSecretKey: stripeSecretDraft.editing && stripeSecretDraft.value ? stripeSecretDraft.value : undefined,
          stripeTreasuryAccountId: Number(savedForm.stripeTreasuryAccountId) || 0,
          vinti4TreasuryAccountId: Number(savedForm.vinti4TreasuryAccountId) || 0,
          defaultDueDay: Number(savedForm.defaultDueDay),
          autoBillingDay: Number(savedForm.autoBillingDay),
          audiovisualMonthlyCve: Number(savedForm.audiovisualMonthlyCve),
          audiovisualAnnualCve: Number(savedForm.audiovisualAnnualCve),
          installationFeeCve: Number(savedForm.installationFeeCve),
          ivaRate: Number(savedForm.ivaRate),
          noticeCooldownDays: Number(savedForm.noticeCooldownDays),
          smsDispatchIntervalSeconds: Number(savedForm.smsDispatchIntervalSeconds),
          smsRetryGraceMinutes: Number(savedForm.smsRetryGraceMinutes),
          networkProbeIntervalSeconds: Number(savedForm.networkProbeIntervalSeconds),
          networkProbeFailThreshold: Number(savedForm.networkProbeFailThreshold),
          routerosPort: Number(savedForm.routerosPort),
          routerosIntervalSeconds: Number(savedForm.routerosIntervalSeconds),
          routerosMaxDisablesPerRun: Number(savedForm.routerosMaxDisablesPerRun),
          autoSuspensionGraceDays: Number(savedForm.autoSuspensionGraceDays),
          autoSuspensionIntervalMinutes: Number(savedForm.autoSuspensionIntervalMinutes),
          autoSuspensionMaxPerRun: Number(savedForm.autoSuspensionMaxPerRun),
          autoSuspensionMaxPercent: Number(savedForm.autoSuspensionMaxPercent),
          ...(confirmPassword === undefined ? {} : { confirmPassword })
        })
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({ error: 'Nao foi possivel gravar configuracoes.' })) as { error?: string };
        const text = result.error || 'Nao foi possivel gravar configuracoes.';
        setMessage({ tone: 'error', text, placement: 'save' });
        return text;
      }

      // As credenciais acabadas de gravar saem do formulário: quem diz que
      // existem são as flags da resposta, não o texto que ficou no campo.
      const result = await response.json().catch(() => ({})) as {
        routerosPasswordConfigured?: boolean;
        ultraMsgTokenConfigured?: boolean;
        metaAccessTokenConfigured?: boolean;
        stripeSecretKeyConfigured?: boolean;
      };
      const settledForm = {
        ...savedForm,
        routerosPassword: '',
        ultraMsgToken: '',
        metaAccessToken: '',
        stripeSecretKey: '',
        stripeSecretKeyConfigured: result.stripeSecretKeyConfigured ?? savedForm.stripeSecretKeyConfigured,
        routerosPasswordConfigured: result.routerosPasswordConfigured ?? savedForm.routerosPasswordConfigured,
        ultraMsgTokenConfigured: result.ultraMsgTokenConfigured ?? savedForm.ultraMsgTokenConfigured,
        metaAccessTokenConfigured: result.metaAccessTokenConfigured ?? savedForm.metaAccessTokenConfigured
      };
      setForm(settledForm);
      setRouterSecretDraft({ editing: false });
      setUltraSecretDraft({ editing: false });
      setMetaSecretDraft({ editing: false });
      setStripeSecretDraft({ editing: false });
      // Desligar a app móvel corta também a verificação do pareamento em curso:
      // desligada, o desktop não contacta o telemóvel.
      if (lastSavedForm?.smsCompanionEnabled !== settledForm.smsCompanionEnabled) {
        if (!settledForm.smsCompanionEnabled && smsSession) void cancelSmsPairing();
        void loadSmsStatus();
      }
      setLastSavedForm(settledForm);
      setSecretsLost([]);
      setMessage({ tone: 'success', text: 'Configuracoes gravadas com sucesso.', placement: 'save' });
      return null;
    } catch {
      const text = 'Falha de rede ao gravar configuracoes.';
      setMessage({ tone: 'error', text, placement: 'save' });
      return text;
    } finally {
      setSaving(false);
    }
  }

  async function probeNetworkNow() {
    setProbeBusy(true);
    setProbeMessage('');
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/probe', { method: 'POST' });
      const result = await response.json() as { skipped?: boolean; checked?: number; up?: number; down?: number };
      if (!response.ok) {
        setProbeMessage('Nao foi possivel sondar a rede.');
      } else if (result.skipped) {
        setProbeMessage('Nenhum equipamento com IP registado para sondar.');
      } else {
        setProbeMessage(`${result.checked} equipamento(s) sondados: ${result.up} de pé, ${result.down} sem resposta.`);
      }
    } catch {
      setProbeMessage('Falha de rede ao sondar.');
    } finally {
      setProbeBusy(false);
    }
  }

  async function loadRouterState() {
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/enforcement');
      if (!response.ok) return;
      setRouterState(await response.json() as RouterEnforcementState);
    } catch {
      // O painel do router é informativo: falhar a leitura não estraga as Definições.
    }
  }

  async function enforceNow() {
    setEnforceBusy(true);
    setEnforceMessage('');
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/enforce', { method: 'POST' });
      const result = await response.json() as {
        error?: string; skipped?: boolean; aborted?: boolean; reason?: string;
        dryRun?: boolean; planned?: number; applied?: number; failed?: number; divergences?: number;
      };
      if (!response.ok) {
        setEnforceMessage(result.error || 'Nao foi possivel reconciliar.');
      } else if (result.skipped) {
        setEnforceMessage(result.reason || 'Nada a reconciliar.');
      } else if (result.aborted) {
        setEnforceMessage(`Travado por seguranca: ${result.reason}. Nada foi alterado no router.`);
      } else if (result.dryRun) {
        setEnforceMessage(`Ensaio: ${result.planned} alteracao(oes) por aplicar, ${result.divergences} divergencia(s). Nada foi alterado.`);
      } else {
        setEnforceMessage(`${result.applied} alteracao(oes) aplicadas, ${result.failed} falha(s).`);
      }
      await loadRouterState();
    } catch {
      setEnforceMessage('Falha de rede ao reconciliar.');
    } finally {
      setEnforceBusy(false);
    }
  }

  async function runAutoSuspensionNow() {
    setAutoSuspendBusy(true);
    setAutoSuspendMessage('');
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/auto-suspension', { method: 'POST' });
      const result = await response.json() as {
        skipped?: boolean;
        aborted?: boolean;
        dryRun?: boolean;
        reason?: string;
        candidateCount?: number;
        blockedByCreditCount?: number;
        simulated?: number;
        applied?: number;
        revalidatedOut?: number;
      };
      if (!response.ok) {
        setAutoSuspendMessage('Nao foi possivel avaliar a suspensao automatica.');
      } else if (result.aborted) {
        setAutoSuspendMessage(`Travado por seguranca: ${result.reason}. Nenhum servico foi suspenso.`);
      } else if (result.skipped) {
        setAutoSuspendMessage(result.reason || 'Suspensao automatica nao executada.');
      } else if (result.dryRun) {
        setAutoSuspendMessage(
          `Ensaio: ${result.simulated ?? result.candidateCount ?? 0} servico(s) seriam suspensos. ${result.blockedByCreditCount ?? 0} protegido(s) por credito. Nada foi alterado.`
        );
      } else {
        setAutoSuspendMessage(
          `${result.applied ?? 0} servico(s) suspensos; ${result.revalidatedOut ?? 0} retirado(s) na validacao final.`
        );
      }
      await loadRouterState();
    } catch {
      setAutoSuspendMessage('Falha de rede ao avaliar a suspensao automatica.');
    } finally {
      setAutoSuspendBusy(false);
    }
  }

  async function testRouterNow() {
    setRouterBusy(true);
    setRouterReport(null);
    setRouterCert(null);
    // O servidor gasta no máximo 10 s a chegar à porta e outros 10 s na REST.
    // Este travão é para o caso de nem isso responder: um botão a rodar para
    // sempre é exatamente o silêncio que este ecrã tinha antes.
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), ROUTER_TEST_TIMEOUT_MS);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/router/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        // Testa o que está no ecrã, não o que está gravado. A senha vem
        // mascarada do servidor: devolvê-la intacta quer dizer "usa a guardada".
        body: JSON.stringify({
          host: form.routerosHost,
          port: Number(form.routerosPort) || 443,
          user: form.routerosUser,
          password: form.routerosPassword,
          tlsCert: form.routerosTlsCert
        })
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setRouterReport(routerNote(result.error || 'O servidor recusou o teste.', 'error'));
        return;
      }
      const report = await response.json() as RouterTestReport;
      setRouterReport(report);
      if (report.certificate && report.fingerprint) {
        // Certificado próprio: em vez de mandar desligar o TLS, propõe fixá-lo.
        setRouterCert({ pem: report.certificate, fingerprint: report.fingerprint });
      }
    } catch (err) {
      setRouterReport(
        routerNote(
          err instanceof DOMException && err.name === 'AbortError'
            ? 'O teste passou dos 30 segundos sem resposta. Confirme que a aplicação está a correr e que o endereço do router existe nesta rede.'
            : 'Falha de rede ao contactar o servidor do ISPM.',
          'error'
        )
      );
    } finally {
      window.clearTimeout(timeout);
      setRouterBusy(false);
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
      await sendWhatsapp(testPhone, body);
      setTestMessage({ tone: 'success', text: 'Mensagem de teste enviada.' });
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
    <section className={scope === 'router' ? undefined : 'module-panel'}>
      {scope === 'all' && (<>
      <div className="module-header">
        <div>
          <p className="eyebrow">Sistema</p>
          <h2>Configurações</h2>
        </div>
      </div>

      <TabList
        className="settings-tabs"
        tabClassName="settings-tab"
        idPrefix="settings"
        label="Configurações por tópico"
        value={activeTab}
        onChange={setActiveTab}
        tabs={TABS.filter((tab) => tab.id !== 'vault' || auth.isAuthBypassed || auth.hasRole('admin'))
          .map(({ id, label, icon: Icon }) => ({ id, label: <><Icon size={14} aria-hidden /><span>{label}</span></> }))}
      />
      </>)}

      {/* Dentro do Router o ecrã é um só tópico, sem abas: aí não há painel de abas. */}
      <div className="tab-panel" {...(scope === 'all' && { role: 'tabpanel', id: `settings-panel-${activeTab}`, 'aria-labelledby': `settings-tab-${activeTab}` })}>

      {secretsLost.length > 0 && (
        <Message tone="error">
          Base criada noutra máquina. Reintroduza e grave: {secretsLost.join('; ')}.
        </Message>
      )}
      {message && message.placement === 'top' && <Message tone={message.tone}>{message.text}</Message>}

      {activeTab !== 'backups' && activeTab !== 'jobs' && activeTab !== 'license' && activeTab !== 'vault' && (
      <form className="client-form settings-form" onSubmit={saveSettings}>
        {activeTab === 'company' && (
          <CompanyTab
            form={form}
            onUpdate={updateForm}
          />
        )}

        {activeTab === 'billing' && (
          <BillingTab form={form} onUpdate={updateForm} onToggle={toggleForm} />
        )}

        {activeTab === 'payments' && (
          <PaymentTab
            form={form}
            onUpdate={updateForm}
            onToggle={toggleForm}
            secretDraft={stripeSecretDraft}
            onSecretDraftChange={setStripeSecretDraft}
          />
        )}

        {activeTab === 'whatsapp' && (
          <WhatsappTab
            form={form}
            secretDraft={ultraSecretDraft}
            onSecretDraftChange={setUltraSecretDraft}
            metaSecretDraft={metaSecretDraft}
            onMetaSecretDraftChange={setMetaSecretDraft}
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
            smsReportMonth={smsReportMonth}
            smsReport={smsReport}
            smsReportLoading={smsReportLoading}
            onSmsReportMonthChange={setSmsReportMonth}
            smsSession={smsSession}
            smsPairingBusy={smsPairingBusy}
            smsDetecting={smsDetecting}
            onDetectPhone={() => void detectSmsPhone()}
            smsSyncing={smsSyncing}
            onSyncNow={() => void syncSmsNow()}
            onCreatePairing={() => {
              setSmsPasswordError(null);
              setSmsPasswordFor('pair');
            }}
            onRevokePairing={() => void revokeSmsPairing()}
            onRenewPairing={() => void renewSmsPairing()}
            onConfirmPairing={() => void confirmSmsPairing()}
            onCancelPairing={() => void cancelSmsPairing()}
          />
        )}

        {activeTab === 'network' && (
          <NetworkTab
            part={scope === 'router' ? 'router' : 'probe'}
            form={form}
            secretDraft={routerSecretDraft}
            onSecretDraftChange={setRouterSecretDraft}
            onUpdate={updateForm}
            onToggle={toggleForm}
            probeBusy={probeBusy}
            probeMessage={probeMessage}
            onProbeNow={() => void probeNetworkNow()}
            routerBusy={routerBusy}
            routerReport={routerReport}
            routerFingerprint={routerCert?.fingerprint ?? ''}
            onRouterTest={() => void testRouterNow()}
            onTrustCertificate={() => {
              if (!routerCert) return;
              updateForm('routerosTlsCert', routerCert.pem);
              setRouterCert(null);
              setRouterReport(routerNote(
                'Certificado fixado no formulário. Teste outra vez para confirmar, e grave para o guardar.',
                'neutral'
              ));
            }}
            routerState={routerState}
            enforceBusy={enforceBusy}
            enforceMessage={enforceMessage}
            onEnforceNow={() => void enforceNow()}
            autoSuspendBusy={autoSuspendBusy}
            autoSuspendMessage={autoSuspendMessage}
            onAutoSuspendNow={() => void runAutoSuspensionNow()}
            onForgetCertificate={() => {
              updateForm('routerosTlsCert', '');
              setRouterCert(null);
              setRouterReport(routerNote(
                'Certificado esquecido no formulário. Teste outra vez para ler o que o router apresenta agora.',
                'neutral'
              ));
            }}
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

      <RouterLiveDialog
        open={liveConfirmOpen}
        form={form}
        routerState={routerState}
        busy={saving}
        error={liveError}
        onConfirm={(password) => void confirmRouterLive(password)}
        onClose={() => setLiveConfirmOpen(false)}
      />

      <AdminPasswordDialog
        open={smsPasswordFor !== null}
        eyebrow="App móvel ISPM SMS"
        title={smsPasswordFor === 'pair' ? 'Parear o telemóvel?' : 'Ligar a app móvel?'}
        lead={smsPasswordFor === 'pair'
          ? 'Parear liga a app móvel: o telemóvel passa a enviar SMS pelo cartão SIM e a receber o resumo da operação.'
          : 'Ligada, o desktop volta a falar com o telemóvel pareado: envia os SMS em fila, atualiza o Painel e lê o estado do telemóvel.'}
        confirmLabel={smsPasswordFor === 'pair' ? 'Gerar pareamento' : 'Ligar'}
        busy={smsPasswordFor === 'pair' ? smsPairingBusy : saving}
        error={smsPasswordError}
        onConfirm={(password) => void confirmSmsPassword(password)}
        onClose={() => setSmsPasswordFor(null)}
      />

      {activeTab === 'fup' && <FupSettingsPanel />}

      {activeTab === 'backups' && <BackupsPanel />}

      {activeTab === 'jobs' && (
        <>
          <JobHealthPanel />
          {/* Consentimento de envio para fora: decisão de administrador, como o Cofre. */}
          {(auth.isAuthBypassed || auth.hasRole('admin')) && <ErrorReportsPanel />}
        </>
      )}

      {activeTab === 'license' && <LicensePanel />}
      {activeTab === 'vault' && (auth.isAuthBypassed || auth.hasRole('admin')) && <VaultPanel />}
      </div>
    </section>
  );
}

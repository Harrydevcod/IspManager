import { Activity, Banknote, Building2, DatabaseBackup, KeyRound, MessageCircle, Radar, Smartphone } from 'lucide-react';
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
import { currentSmsReportMonth } from '../../shared/sms-report';
import type { SmsMonthlyReport, SmsStatus } from '../types';
import { BackupsPanel } from './BackupsPanel';
import { BillingTab } from './settings/BillingTab';
import { CompanyTab } from './settings/CompanyTab';
import { SmsTab } from './settings/SmsTab';
import { WhatsappTab } from './settings/WhatsappTab';
import type { SettingsFormState } from './settings/settingsForm';
import { NetworkTab, type RouterEnforcementState, type RouterTestReport } from './settings/NetworkTab';
import { RouterLiveDialog } from './settings/RouterLiveDialog';
import { JobHealthPanel } from './JobHealthPanel';
import { LicensePanel } from './LicensePanel';

type SettingsTab = 'company' | 'billing' | 'whatsapp' | 'sms' | 'network' | 'backups' | 'jobs' | 'license';

const TABS: { id: SettingsTab; label: string; icon: typeof Building2 }[] = [
  { id: 'company', label: 'Empresa', icon: Building2 },
  { id: 'billing', label: 'Faturação', icon: Banknote },
  { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { id: 'sms', label: 'SMS', icon: Smartphone },
  { id: 'network', label: 'Rede', icon: Radar },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup },
  { id: 'jobs', label: 'Automatismos', icon: Activity },
  { id: 'license', label: 'Licença', icon: KeyRound }
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
};

export function SettingsModule({ scope = 'all' }: SettingsModuleProps = {}) {
  const [message, setMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string; placement: 'top' | 'save' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testMessage, setTestMessage] = useState<{ tone: 'neutral' | 'success' | 'error'; text: string } | null>(null);
  const [lastSavedForm, setLastSavedForm] = useState<SettingsFormState | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(scope === 'router' ? 'network' : 'company');
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
    routerosSuspendedProfile: 'SUSPENSO',
    autoSuspensionEnabled: false,
    autoSuspensionGraceDays: '15',
    autoSuspensionIntervalMinutes: '60',
    autoSuspensionMaxPerRun: '5',
    autoSuspensionMaxPercent: '20'
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
  const [smsStatus, setSmsStatus] = useState<SmsStatus | null>(null);
  const [smsReportMonth, setSmsReportMonth] = useState(currentSmsReportMonth);
  const [smsReport, setSmsReport] = useState<SmsMonthlyReport | null>(null);
  const [smsReportLoading, setSmsReportLoading] = useState(false);
  const [smsPairing, setSmsPairing] = useState<{ baseUrl: string; deviceName: string }>({ baseUrl: '', deviceName: '' });
  const [smsPairingBusy, setSmsPairingBusy] = useState(false);
  const [smsDetecting, setSmsDetecting] = useState(false);
  const [smsQrDataUrl, setSmsQrDataUrl] = useState<string>('');
  const [smsVerifying, setSmsVerifying] = useState(false);
  const pairingPollRef = useRef<{ cancelled: boolean } | null>(null);
  const smsReportRequestRef = useRef(0);
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
    // Remember the last thing the phone told us so a timeout can explain *why*:
    // never reachable → wrong IP / off-network; reachable but never paired →
    // the QR was not read (or an old one was).
    let everReachable = false;
    try {
      while (!token.cancelled && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (token.cancelled) return;
        try {
          const response = await authFetch('http://127.0.0.1:3001/api/sms/pairing/verify');
          const data = (await response.json().catch(() => ({}))) as { reachable?: boolean; paired?: boolean; deviceName?: string };
          if (token.cancelled) return;
          if (data.reachable) everReachable = true;
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
          text: everReachable
            ? `O telemovel "${deviceName}" respondeu mas nao aceitou o pareamento. Le o QR Code atual (nao um antigo) no app ISPM SMS e tenta de novo.`
            : `O telemovel "${deviceName}" nao respondeu em ${smsPairing.baseUrl || 'endereco guardado'}. Confirma que o app ISPM SMS esta aberto, na mesma rede Wi-Fi, e que o endereco/IP esta correto (usa "Detetar telemovel na rede").`,
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

  async function detectSmsPhone() {
    setSmsDetecting(true);
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/sms/discover', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { baseUrl?: string | null; candidates?: string[] };
      if (!response.ok) {
        setMessage({ tone: 'error', text: 'Nao foi possivel procurar o telemovel na rede.', placement: 'top' });
        return;
      }
      if (data.baseUrl) {
        setSmsPairing((current) => ({ ...current, baseUrl: data.baseUrl as string }));
        setMessage({ tone: 'success', text: `Telemovel encontrado em ${data.baseUrl}. Confirma o nome e gera o pareamento.`, placement: 'top' });
      } else if (data.candidates && data.candidates.length > 1) {
        setSmsPairing((current) => ({ ...current, baseUrl: data.candidates![0] }));
        setMessage({ tone: 'neutral', text: `Varios dispositivos respondem na porta do companion (${data.candidates.join(', ')}). Confirma qual e o telemovel.`, placement: 'top' });
      } else {
        setMessage({ tone: 'error', text: 'Nenhum telemovel encontrado na rede local. Confirma que o app ISPM SMS esta aberto no telemovel e na mesma rede Wi-Fi.', placement: 'top' });
      }
    } catch {
      setMessage({ tone: 'error', text: 'Falha de rede ao procurar o telemovel.', placement: 'top' });
    } finally {
      setSmsDetecting(false);
    }
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
        return response.json() as Promise<Omit<SettingsFormState, 'defaultDueDay' | 'autoBillingDay' | 'audiovisualMonthlyCve' | 'audiovisualAnnualCve' | 'installationFeeCve' | 'ivaRate' | 'whatsappSuspensionNoticeDays' | 'noticeCooldownDays' | 'smsDispatchIntervalSeconds' | 'smsRetryGraceMinutes' | 'networkProbeIntervalSeconds' | 'networkProbeFailThreshold' | 'routerosPort' | 'routerosIntervalSeconds' | 'routerosMaxDisablesPerRun' | 'autoSuspensionGraceDays' | 'autoSuspensionIntervalMinutes' | 'autoSuspensionMaxPerRun' | 'autoSuspensionMaxPercent'> & { defaultDueDay: number; autoBillingDay: number; audiovisualMonthlyCve: number; audiovisualAnnualCve: number; installationFeeCve: number; ivaRate: number; whatsappSuspensionNoticeDays: number; noticeCooldownDays: number; smsDispatchIntervalSeconds: number; smsRetryGraceMinutes: number; networkProbeIntervalSeconds: number; networkProbeFailThreshold: number; routerosPort: number; routerosIntervalSeconds: number; routerosMaxDisablesPerRun: number; autoSuspensionGraceDays: number; autoSuspensionIntervalMinutes: number; autoSuspensionMaxPerRun: number; autoSuspensionMaxPercent: number; secretsLost?: string[] }>;
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
          whatsappSuspensionNoticeDays: String(settings.whatsappSuspensionNoticeDays),
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
          autoSuspensionMaxPercent: String(settings.autoSuspensionMaxPercent)
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
    if (activeTab === 'sms') void loadSmsStatus();
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

    await persistSettings();
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
          defaultDueDay: Number(savedForm.defaultDueDay),
          autoBillingDay: Number(savedForm.autoBillingDay),
          audiovisualMonthlyCve: Number(savedForm.audiovisualMonthlyCve),
          audiovisualAnnualCve: Number(savedForm.audiovisualAnnualCve),
          installationFeeCve: Number(savedForm.installationFeeCve),
          ivaRate: Number(savedForm.ivaRate),
          whatsappSuspensionNoticeDays: Number(savedForm.whatsappSuspensionNoticeDays),
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

      setForm(savedForm);
      setLastSavedForm(savedForm);
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
    <section className={scope === 'router' ? undefined : 'module-panel'}>
      {scope === 'all' && (<>
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
      </>)}

      {secretsLost.length > 0 && (
        <Message tone="error">
          Esta base de dados foi criada noutra máquina ou noutra conta Windows. As credenciais
          ficam seladas na conta de quem as escreveu — por desenho, para um ficheiro copiado não
          valer nada — e por isso estas não vieram: {secretsLost.join('; ')}. Reintroduza-as aqui
          e grave. Clientes, faturas e histórico foram restaurados na íntegra.
        </Message>
      )}
      {message && message.placement === 'top' && <Message tone={message.tone}>{message.text}</Message>}

      {activeTab !== 'backups' && activeTab !== 'jobs' && activeTab !== 'license' && (
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
            smsReportMonth={smsReportMonth}
            smsReport={smsReport}
            smsReportLoading={smsReportLoading}
            onSmsReportMonthChange={setSmsReportMonth}
            smsPairing={smsPairing}
            onPairingChange={(field, value) => setSmsPairing((current) => ({ ...current, [field]: value }))}
            smsVerifying={smsVerifying}
            smsPairingBusy={smsPairingBusy}
            smsDetecting={smsDetecting}
            smsQrDataUrl={smsQrDataUrl}
            onDetectPhone={() => void detectSmsPhone()}
            onCreatePairing={() => void createSmsPairing()}
            onRevokePairing={() => void revokeSmsPairing()}
          />
        )}

        {activeTab === 'network' && (
          <NetworkTab
            part={scope === 'router' ? 'router' : 'probe'}
            form={form}
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

      {activeTab === 'backups' && <BackupsPanel />}

      {activeTab === 'jobs' && <JobHealthPanel />}

      {activeTab === 'license' && <LicensePanel />}
    </section>
  );
}

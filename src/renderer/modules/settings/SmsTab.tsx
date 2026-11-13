import { Check, QrCode, RefreshCw, RotateCcw, Unlink, Wifi } from 'lucide-react';
import { SmsInbox } from './SmsInbox';
import { Button, Field, Toggle } from '../../components';
import type { SmsMonthlyReport, SmsStatus } from '../../types';
import { TemplateField } from './TemplateField';
import {
  fallbackSmsInvoiceIssuedTemplate,
  fallbackSmsPaymentOverdueTemplate,
  fallbackSmsReceiptConfirmedTemplate,
  fallbackSmsSuspensionNoticeTemplate
} from '../../../shared/sms';
import { type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';
import { describeSmsPairing, describeSmsPresence, type SmsPairingSession } from './smsPresence';

/** Sessão de pareamento v2 no ecrã: o QR e, depois de o telemóvel o ler, o código. */
export type SmsPairingScreen = SmsPairingSession & { qrDataUrl: string; sas?: string };

type SmsTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  smsStatus: SmsStatus | null;
  smsReportMonth: string;
  smsReport: SmsMonthlyReport | null;
  smsReportLoading: boolean;
  onSmsReportMonthChange: (month: string) => void;
  smsSession: SmsPairingScreen | null;
  smsPairingBusy: boolean;
  smsDetecting: boolean;
  onDetectPhone: () => void;
  smsSyncing: boolean;
  /** Troca completa com o telemóvel já: resumo, canal de volta e fila de SMS. */
  onSyncNow: () => void;
  onCreatePairing: () => void;
  onRevokePairing: () => void;
  /** O QR expirou sem ser lido: um QR novo, sem pedir outra vez a password. */
  onRenewPairing: () => void;
  /** O operador viu o mesmo código nos dois ecrãs. */
  onConfirmPairing: () => void;
  onCancelPairing: () => void;
};

export function SmsTab({
  form,
  onUpdate,
  onToggle,
  smsStatus,
  smsReportMonth,
  smsReport,
  smsReportLoading,
  onSmsReportMonthChange,
  smsSession,
  smsPairingBusy,
  smsDetecting,
  onDetectPhone,
  smsSyncing,
  onSyncNow,
  onCreatePairing,
  onRevokePairing,
  onRenewPairing,
  onConfirmPairing,
  onCancelPairing
}: SmsTabProps) {
  const pairing = describeSmsPairing(smsStatus, smsSession);
  const presence = smsSession ? null : describeSmsPresence(smsStatus);

  return (
    <>
      <Toggle
        title="Ligação à app móvel ISPM SMS"
        description="Ligar pede a password de administrador."
        checked={form.smsCompanionEnabled}
        // Nunca os dois canais desligados: sem o WhatsApp ligado, o SMS não se desliga.
        disabled={form.smsCompanionEnabled && !form.whatsappChannelEnabled}
        onChange={(event) => onToggle('smsCompanionEnabled', event.target.checked)}
      />
      <Toggle
        title="Avisos automáticos de atraso e corte por SMS"
        checked={form.smsAutoNoticesEnabled}
        disabled={!form.smsCompanionEnabled}
        onChange={(event) => onToggle('smsAutoNoticesEnabled', event.target.checked)}
      />
      <div className="settings-test-whatsapp" aria-label="Pareamento do Android SMS">
        <span className="sms-pairing-state" data-tone={pairing.tone} role="status">{pairing.line}</span>
        {presence && (
          <div className="sms-presence" data-tone={presence.tone} role="status">
            <span className="sms-presence-dot" aria-hidden />
            <span>{presence.line}</span>
            {presence.warnings.map((warning) => (
              <small key={warning} className="sms-presence-warning">{warning}</small>
            ))}
          </div>
        )}
        {presence && smsStatus?.enabled && smsStatus.configured && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onSyncNow}
            loading={smsSyncing}
            disabled={smsPairingBusy}
            leadingIcon={<RefreshCw size={14} aria-hidden />}
          >
            Sincronizar agora
          </Button>
        )}
        {smsSession?.state === 'found' ? (
          <div className="sms-pairing-confirm" role="group" aria-label="Código de confirmação">
            <span className="sms-pairing-confirm-label">Código no telemóvel</span>
            <output className="sms-pairing-sas">{`${smsSession.sas?.slice(0, 3)} ${smsSession.sas?.slice(3)}`}</output>
            <div className="sms-pairing-actions">
              <Button variant="primary" onClick={onConfirmPairing} loading={smsPairingBusy} leadingIcon={<Check size={14} aria-hidden />}>
                Confirmar
              </Button>
              <Button variant="critical" onClick={onCancelPairing} disabled={smsPairingBusy}>
                Não coincide
              </Button>
            </div>
          </div>
        ) : smsSession ? (
          <div className="sms-pairing-qr" data-state={smsSession.state}>
            <img src={smsSession.qrDataUrl} alt="QR Code de pareamento do Android SMS" width={220} height={220} />
            <span>{smsSession.state === 'waiting' ? 'Na app ISPM SMS: Ler QR Code.' : 'Ninguém leu este QR em 2 min.'}</span>
            <div className="sms-pairing-actions">
              {smsSession.state === 'expired' && (
                <Button variant="primary" onClick={onRenewPairing} loading={smsPairingBusy} leadingIcon={<RotateCcw size={14} aria-hidden />}>
                  Novo QR
                </Button>
              )}
              <Button variant="critical" onClick={onCancelPairing} disabled={smsPairingBusy}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="sms-pairing-actions">
            {pairing.primary === 'detect' && (
              <Button variant="primary" onClick={onDetectPhone} loading={smsDetecting} disabled={smsPairingBusy} leadingIcon={<Wifi size={14} aria-hidden />}>
                Procurar telemóvel
              </Button>
            )}
            <Button
              variant={pairing.primary === 'pair' ? 'primary' : 'secondary'}
              onClick={onCreatePairing}
              loading={smsPairingBusy}
              leadingIcon={<QrCode size={14} aria-hidden />}
            >
              {pairing.pairLabel}
            </Button>
            {smsStatus?.configured && (
              <Button
                variant="critical"
                onClick={onRevokePairing}
                disabled={smsPairingBusy}
                leadingIcon={<Unlink size={14} aria-hidden />}
              >
                Revogar pareamento
              </Button>
            )}
          </div>
        )}
      </div>
      <SmsInbox />
      <section className="sms-delivery-report" aria-labelledby="sms-delivery-report-title">
        <div className="sms-delivery-report-head">
          <div>
            <span className="sms-delivery-report-eyebrow">Canal SMS</span>
            <h3 id="sms-delivery-report-title">Relatório de entrega de SMS</h3>
          </div>
          <Field
            className="sms-report-month"
            label="Mês"
            type="month"
            value={smsReportMonth}
            onChange={(event) => {
              if (event.target.value) onSmsReportMonthChange(event.target.value);
            }}
          />
        </div>
        {smsReportLoading ? (
          <span className="sms-report-loading" role="status">A carregar relatório…</span>
        ) : smsReport?.month === smsReportMonth ? (
          <div className="sms-queue" role="group" aria-label="Fila SMS">
            {([
              { key: 'pendingDispatch', label: 'por entregar', tone: 'warn' },
              { key: 'pendingApproval', label: 'por aprovar', tone: 'neutral' },
              { key: 'sent', label: 'enviados', tone: 'success' },
              { key: 'delivered', label: 'entregues', tone: 'success' },
              { key: 'failed', label: 'falhados', tone: 'danger' },
              { key: 'rejected', label: 'rejeitados', tone: 'danger' }
            ] as const).map(({ key, label, tone }) => (
              <div key={key} className="sms-queue-stat" data-tone={tone}>
                <span className="sms-queue-stat-value">{smsReport.counts[key]}</span>
                <span className="sms-queue-stat-label">{label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <Field
        className="field-short"
        label="Intervalo de envio SMS (segundos)"
        type="number"
        min={15}
        max={3600}
        value={form.smsDispatchIntervalSeconds}
        onChange={(event) => onUpdate('smsDispatchIntervalSeconds', event.target.value)}
      />
      <Field
        className="field-short"
        label="Reenvio após falha (minutos)"
        type="number"
        min={1}
        max={1440}
        value={form.smsRetryGraceMinutes}
        onChange={(event) => onUpdate('smsRetryGraceMinutes', event.target.value)}
      />
      <TemplateField
        field="smsInvoiceIssuedTemplate"
        label="SMS: emissão de fatura"
        hint="Evite acentos: com eles cada SMS cai de 160 para 70 caracteres."
        value={form.smsInvoiceIssuedTemplate}
        recommended={fallbackSmsInvoiceIssuedTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsReceiptConfirmedTemplate"
        label="SMS: confirmação de recibo"
        value={form.smsReceiptConfirmedTemplate}
        recommended={fallbackSmsReceiptConfirmedTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsPaymentOverdueTemplate"
        label="SMS: atraso de pagamento"
        value={form.smsPaymentOverdueTemplate}
        recommended={fallbackSmsPaymentOverdueTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsSuspensionNoticeTemplate"
        label="SMS: aviso de suspensão"
        value={form.smsSuspensionNoticeTemplate}
        recommended={fallbackSmsSuspensionNoticeTemplate}
        onUpdate={onUpdate}
      />
    </>
  );
}

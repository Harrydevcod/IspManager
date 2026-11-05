import { QrCode, RotateCcw, Unlink, Wifi } from 'lucide-react';
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
import { describeSmsPairing, describeSmsPresence } from './smsPresence';

type SmsPairing = { baseUrl: string; deviceName: string };

type SmsTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  smsStatus: SmsStatus | null;
  smsReportMonth: string;
  smsReport: SmsMonthlyReport | null;
  smsReportLoading: boolean;
  onSmsReportMonthChange: (month: string) => void;
  smsPairing: SmsPairing;
  onPairingChange: (field: keyof SmsPairing, value: string) => void;
  smsVerifying: boolean;
  smsPairingBusy: boolean;
  smsDetecting: boolean;
  smsQrDataUrl: string;
  onDetectPhone: () => void;
  onCreatePairing: () => void;
  onRevokePairing: () => void;
  /** O QR expirou sem ser lido: volta a esperar pelo mesmo QR. */
  onResumeVerification: () => void;
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
  smsPairing,
  onPairingChange,
  smsVerifying,
  smsPairingBusy,
  smsDetecting,
  smsQrDataUrl,
  onDetectPhone,
  onCreatePairing,
  onRevokePairing,
  onResumeVerification
}: SmsTabProps) {
  const pairing = describeSmsPairing(smsStatus, { verifying: smsVerifying, qrShown: Boolean(smsQrDataUrl), formBaseUrl: smsPairing.baseUrl });
  const presence = pairing.state === 'waiting' || pairing.state === 'expired' ? null : describeSmsPresence(smsStatus);
  const qrOpen = pairing.state === 'waiting' || pairing.state === 'expired';

  return (
    <>
      <Toggle
        title="Ligação à app móvel ISPM SMS"
        description="Ligada, o desktop envia os SMS ao telemóvel pareado (que pede aprovação antes de usar o cartão SIM), atualiza o Painel da app e lê o estado do telemóvel. Desligada, não o contacta de forma nenhuma: o pareamento fica guardado e os SMS em fila saem quando voltar a ligar. Ligar pede a password de administrador."
        checked={form.smsCompanionEnabled}
        onChange={(event) => onToggle('smsCompanionEnabled', event.target.checked)}
      />
      <Toggle
        title="Avisos automaticos de atraso e corte por SMS"
        description="Uma vez por dia, cada fatura em atraso ou perto do corte gera um SMS para todos os clientes com telefone valido, alem do WhatsApp. Chegam ao telemovel para aprovar (Aprovar todos). Clientes que recusaram avisos ficam de fora."
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
        <Field
          label="Endereco do Android na rede local"
          value={smsPairing.baseUrl}
          onChange={(event) => onPairingChange('baseUrl', event.target.value)}
          placeholder="http://192.168.1.50:8765"
          disabled={qrOpen}
        />
        {pairing.addressChanged && !qrOpen && (
          <small className="sms-presence-warning">
            Endereço diferente do guardado ({smsStatus?.baseUrl}). Só passa a valer com um novo pareamento.
          </small>
        )}
        <Button
          variant={pairing.primary === 'detect' ? 'primary' : 'ghost'}
          onClick={onDetectPhone}
          loading={smsDetecting}
          disabled={smsPairingBusy || qrOpen}
          leadingIcon={<Wifi size={14} aria-hidden />}
        >
          Procurar telemóvel na rede
        </Button>
        <Field
          label="Nome do dispositivo"
          value={smsPairing.deviceName}
          onChange={(event) => onPairingChange('deviceName', event.target.value)}
          placeholder="Telemóvel da loja"
          disabled={qrOpen}
        />
        {qrOpen ? (
          <div className="sms-pairing-qr" data-state={pairing.state}>
            <img src={smsQrDataUrl} alt="QR Code de pareamento do Android SMS" width={220} height={220} />
            <span>{pairing.state === 'waiting'
              ? 'No telemóvel, abra a app ISPM SMS e leia este QR. Se a app já estiver pareada: Definições → "Esquecer e parear de novo".'
              : 'Ninguém leu este QR em 60 s. Continue à espera ou cancele e comece de novo.'}</span>
            <div className="form-actions">
              {pairing.state === 'expired' && (
                <Button variant="primary" onClick={onResumeVerification} leadingIcon={<RotateCcw size={14} aria-hidden />}>
                  Continuar à espera
                </Button>
              )}
              <Button variant="critical" onClick={onRevokePairing} disabled={smsPairingBusy}>
                Cancelar pareamento
              </Button>
            </div>
          </div>
        ) : (
          <div className="form-actions">
            <Button
              variant={pairing.primary === 'pair' ? 'primary' : 'secondary'}
              onClick={onCreatePairing}
              disabled={!smsPairing.baseUrl || !smsPairing.deviceName}
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
        label="Reenvio apos falha (minutos)"
        type="number"
        min={1}
        max={1440}
        value={form.smsRetryGraceMinutes}
        onChange={(event) => onUpdate('smsRetryGraceMinutes', event.target.value)}
      />
      <TemplateField
        field="smsInvoiceIssuedTemplate"
        label="SMS — emissão de fatura"
        hint="Sem acentos (á, ã, ç, õ): com eles cada SMS passa de 160 para 70 caracteres e custa 2 a 3 mensagens."
        value={form.smsInvoiceIssuedTemplate}
        recommended={fallbackSmsInvoiceIssuedTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsReceiptConfirmedTemplate"
        label="SMS — confirmação de recibo"
        value={form.smsReceiptConfirmedTemplate}
        recommended={fallbackSmsReceiptConfirmedTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsPaymentOverdueTemplate"
        label="SMS — atraso de pagamento"
        value={form.smsPaymentOverdueTemplate}
        recommended={fallbackSmsPaymentOverdueTemplate}
        onUpdate={onUpdate}
      />
      <TemplateField
        field="smsSuspensionNoticeTemplate"
        label="SMS — aviso de suspensão"
        value={form.smsSuspensionNoticeTemplate}
        recommended={fallbackSmsSuspensionNoticeTemplate}
        onUpdate={onUpdate}
      />
    </>
  );
}

import { QrCode, RotateCcw, Unlink, Wifi } from 'lucide-react';
import { Button, Field, Textarea, Toggle } from '../../components';
import type { SmsMonthlyReport, SmsStatus } from '../../types';
import { templateRows, type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';

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
  onRevokePairing
}: SmsTabProps) {
  const pairingLabel = smsVerifying
    ? 'A aguardar confirmacao do telemovel...'
    : smsStatus?.active
      ? `Ativo${smsStatus.deviceName ? `: ${smsStatus.deviceName}` : ''}${smsStatus.baseUrl ? ` (${smsStatus.baseUrl})` : ''}`
      : smsStatus?.configured
        ? smsStatus.reachable
          ? `Inativo: ${smsStatus.deviceName || 'Android'} responde, mas nao aceitou este pareamento. Repareia o telemovel.`
          : `Inativo: ${smsStatus.deviceName || 'Android'} nao responde em ${smsStatus.baseUrl || 'endereco guardado'}. O IP pode ter mudado.`
        : 'Android nao pareado';
  const createPairingLabel = smsStatus?.configured && !smsStatus.active
    ? 'Voltar atras e reparear'
    : smsStatus?.configured
      ? 'Gerar novo pareamento'
      : 'Gerar pareamento';

  return (
    <>
      <Toggle
        title="Ativar SMS via Android"
        description="O desktop enfileira os SMS e o telemovel Android pareado pede aprovacao antes de enviar pelo cartao SIM. Ideal como canal de reforco quando o cliente nao tem WhatsApp."
        checked={form.smsCompanionEnabled}
        onChange={(event) => onToggle('smsCompanionEnabled', event.target.checked)}
      />
      <div className="settings-test-whatsapp" aria-label="Pareamento do Android SMS">
        <span>{pairingLabel}</span>
        <Field
          label="Endereco do Android na rede local"
          value={smsPairing.baseUrl}
          onChange={(event) => onPairingChange('baseUrl', event.target.value)}
          placeholder="http://192.168.1.50:8765"
        />
        <Button
          variant="ghost"
          onClick={onDetectPhone}
          loading={smsDetecting}
          disabled={smsPairingBusy}
          leadingIcon={<Wifi size={14} aria-hidden />}
        >
          Detetar telemovel na rede
        </Button>
        <Field
          label="Nome do dispositivo"
          value={smsPairing.deviceName}
          onChange={(event) => onPairingChange('deviceName', event.target.value)}
          placeholder="Telemovel da loja"
        />
        <div className="form-actions">
          <Button
            variant="secondary"
            onClick={onCreatePairing}
            disabled={!smsPairing.baseUrl || !smsPairing.deviceName}
            loading={smsPairingBusy}
            leadingIcon={<QrCode size={14} aria-hidden />}
          >
            {createPairingLabel}
          </Button>
          {smsStatus?.configured && (
            <Button
              variant="ghost"
              onClick={onRevokePairing}
              disabled={smsPairingBusy}
              leadingIcon={smsStatus.active ? <Unlink size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />}
            >
              Revogar
            </Button>
          )}
        </div>
        {smsQrDataUrl && (
          <div className="sms-pairing-qr">
            <img src={smsQrDataUrl} alt="QR Code de pareamento do Android SMS" width={220} height={220} />
            <span>{smsVerifying
              ? 'Lê este QR no app ISPM SMS do telemóvel — a aguardar confirmação…'
              : 'Lê este QR no app ISPM SMS do telemóvel para parear.'}</span>
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
      <Textarea
        className="whatsapp-template-field"
        label="SMS — emissao de fatura"
        rows={templateRows(form.smsInvoiceIssuedTemplate)}
        value={form.smsInvoiceIssuedTemplate}
        onChange={(event) => onUpdate('smsInvoiceIssuedTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="SMS — confirmacao de recibo"
        rows={templateRows(form.smsReceiptConfirmedTemplate)}
        value={form.smsReceiptConfirmedTemplate}
        onChange={(event) => onUpdate('smsReceiptConfirmedTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="SMS — atraso de pagamento"
        rows={templateRows(form.smsPaymentOverdueTemplate)}
        value={form.smsPaymentOverdueTemplate}
        onChange={(event) => onUpdate('smsPaymentOverdueTemplate', event.target.value)}
      />
      <Textarea
        className="whatsapp-template-field"
        label="SMS — aviso de suspensao"
        rows={templateRows(form.smsSuspensionNoticeTemplate)}
        value={form.smsSuspensionNoticeTemplate}
        onChange={(event) => onUpdate('smsSuspensionNoticeTemplate', event.target.value)}
      />
    </>
  );
}

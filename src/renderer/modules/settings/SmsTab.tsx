import { Button, Field, Message, Textarea, Toggle } from '../../components';
import type { SmsStatus } from '../../types';
import { templateRows, type SettingsFormState, type ToggleField, type UpdateField } from './settingsForm';

type SmsPairing = { baseUrl: string; deviceName: string };

type SmsTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  smsStatus: SmsStatus | null;
  smsPairing: SmsPairing;
  onPairingChange: (field: keyof SmsPairing, value: string) => void;
  smsVerifying: boolean;
  smsPairingBusy: boolean;
  smsQrDataUrl: string;
  onCreatePairing: () => void;
  onRevokePairing: () => void;
};

export function SmsTab({
  form,
  onUpdate,
  onToggle,
  smsStatus,
  smsPairing,
  onPairingChange,
  smsVerifying,
  smsPairingBusy,
  smsQrDataUrl,
  onCreatePairing,
  onRevokePairing
}: SmsTabProps) {
  return (
    <>
      <Toggle
        title="Ativar SMS via Android"
        description="O desktop enfileira os SMS e o telemovel Android pareado pede aprovacao antes de enviar pelo cartao SIM. Ideal como canal de reforco quando o cliente nao tem WhatsApp."
        checked={form.smsCompanionEnabled}
        onChange={(event) => onToggle('smsCompanionEnabled', event.target.checked)}
      />
      <div className="settings-test-whatsapp" aria-label="Pareamento do Android SMS">
        <span>{smsVerifying
          ? 'A aguardar confirmacao do telemovel...'
          : smsStatus?.paired
            ? `Pareado${smsStatus.deviceName ? `: ${smsStatus.deviceName}` : ''}${smsStatus.baseUrl ? ` (${smsStatus.baseUrl})` : ''}`
            : 'Android nao pareado'}</span>
        <Field
          label="Endereco do Android na rede local"
          value={smsPairing.baseUrl}
          onChange={(event) => onPairingChange('baseUrl', event.target.value)}
          placeholder="http://192.168.1.50:8765"
        />
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
          >
            {smsStatus?.paired ? 'Gerar novo pareamento' : 'Gerar pareamento'}
          </Button>
          {smsStatus?.paired && (
            <Button variant="ghost" onClick={onRevokePairing} disabled={smsPairingBusy}>
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
      {smsStatus && (
        <Message tone={smsStatus.counts.failed > 0 ? 'error' : 'neutral'}>
          Fila SMS: {smsStatus.counts.pendingDispatch} por entregar, {smsStatus.counts.pendingApproval} a aguardar aprovacao no Android, {smsStatus.counts.failed} falhado(s).
        </Message>
      )}
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

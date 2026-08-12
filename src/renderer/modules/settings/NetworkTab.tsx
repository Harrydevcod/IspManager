import { Radar } from 'lucide-react';
import { Button, Field, Toggle } from '../../components';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

type NetworkTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  probeBusy: boolean;
  probeMessage: string;
  onProbeNow: () => void;
};

export function NetworkTab({ form, onUpdate, onToggle, probeBusy, probeMessage, onProbeNow }: NetworkTabProps) {
  return (
    <>
      <Toggle
        title="Sonda de rede"
        description="Faz ping periódico aos equipamentos com IP registado e mostra em Relatórios → Operação quais estão de pé. Só lê a rede: não altera nada em nenhum equipamento."
        checked={form.networkProbeEnabled}
        onChange={(event) => onToggle('networkProbeEnabled', event.target.checked)}
      />
      {form.networkProbeEnabled && (
        <>
          <Field
            label="Intervalo entre leituras (segundos)"
            type="number"
            min={30}
            max={3600}
            value={form.networkProbeIntervalSeconds}
            onChange={(event) => onUpdate('networkProbeIntervalSeconds', event.target.value)}
            hint="Aplica-se sem reiniciar. A sonda só corre com a aplicação aberta."
          />
          <Field
            label="Falhas seguidas para declarar em baixo"
            type="number"
            min={1}
            max={10}
            value={form.networkProbeFailThreshold}
            onChange={(event) => onUpdate('networkProbeFailThreshold', event.target.value)}
            hint="Um ping perdido numa ligação rádio é normal. Três seguidas já é avaria."
          />
          <Toggle
            title="Sondar também os equipamentos dos clientes"
            description="Além do backbone, faz ping às CPEs com IP fixo de serviços ativos. Mais leituras, mais ruído: liga quando quiseres detetar o cliente em baixo antes de ele telefonar."
            checked={form.networkProbeIncludeClients}
            onChange={(event) => onToggle('networkProbeIncludeClients', event.target.checked)}
          />
        </>
      )}
      <div className="settings-test-whatsapp" aria-label="Teste da sonda de rede">
        <span>{probeMessage || 'Sonda todos os equipamentos com IP uma vez, sem esperar pelo intervalo.'}</span>
        <div className="form-actions">
          <Button
            variant="secondary"
            onClick={onProbeNow}
            loading={probeBusy}
            leadingIcon={<Radar size={14} aria-hidden />}
          >
            Testar agora
          </Button>
        </div>
      </div>
    </>
  );
}

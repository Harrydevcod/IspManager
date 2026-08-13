import { Radar, Router, ShieldCheck } from 'lucide-react';
import { Button, Field, Toggle } from '../../components';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

type NetworkTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  probeBusy: boolean;
  probeMessage: string;
  onProbeNow: () => void;
  routerBusy: boolean;
  routerMessage: string;
  routerFingerprint: string;
  onRouterTest: () => void;
  onTrustFingerprint: () => void;
};

export function NetworkTab({
  form,
  onUpdate,
  onToggle,
  probeBusy,
  probeMessage,
  onProbeNow,
  routerBusy,
  routerMessage,
  routerFingerprint,
  onRouterTest,
  onTrustFingerprint
}: NetworkTabProps) {
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

      <Toggle
        title="Router MikroTik"
        description="Liga o ISPM ao router para cortar e repor clientes sozinho, aprovisionar o acesso PPPoE e mostrar quem está mesmo online. Enquanto o ensaio estiver ligado, nada é alterado no router."
        checked={form.routerosEnabled}
        onChange={(event) => onToggle('routerosEnabled', event.target.checked)}
      />
      {form.routerosEnabled && (
        <>
          <Field
            label="Endereço do router"
            value={form.routerosHost}
            onChange={(event) => onUpdate('routerosHost', event.target.value)}
            placeholder="192.168.88.1"
            hint="IP na LAN. O serviço www-ssl tem de estar ligado no RouterOS."
          />
          <Field
            label="Porta"
            type="number"
            min={1}
            max={65535}
            value={form.routerosPort}
            onChange={(event) => onUpdate('routerosPort', event.target.value)}
          />
          <Field
            label="Utilizador da API"
            value={form.routerosUser}
            onChange={(event) => onUpdate('routerosUser', event.target.value)}
            hint="Utilizador dedicado, com o grupo limitado a read, write, api e rest-api — nunca full."
          />
          <Field
            label="Senha"
            type="password"
            value={form.routerosPassword}
            onChange={(event) => onUpdate('routerosPassword', event.target.value)}
            hint="Fica guardada nesta máquina e nunca volta a sair em claro."
          />
          <Field
            label="Impressão digital do certificado (SHA-256)"
            value={form.routerosTlsFingerprint}
            onChange={(event) => onUpdate('routerosTlsFingerprint', event.target.value)}
            hint="O certificado do router é próprio. Fixá-lo aqui é o que permite confiar na ligação sem desligar a verificação."
          />
          <Toggle
            title="Ensaio (não altera nada no router)"
            description="Calcula tudo o que faria — cortes, reposições, secrets em falta, velocidades — e mostra o relatório sem tocar no router. Desligue só depois de conferir o relatório contra o parque real."
            checked={form.routerosDryRun}
            onChange={(event) => onToggle('routerosDryRun', event.target.checked)}
          />
          <Field
            label="Intervalo de reconciliação (segundos)"
            type="number"
            min={30}
            max={3600}
            value={form.routerosIntervalSeconds}
            onChange={(event) => onUpdate('routerosIntervalSeconds', event.target.value)}
            hint="Aplica-se sem reiniciar. Só corre com a aplicação aberta."
          />
          <Field
            label="Máximo de cortes por passagem"
            type="number"
            min={1}
            max={500}
            value={form.routerosMaxDisablesPerRun}
            onChange={(event) => onUpdate('routerosMaxDisablesPerRun', event.target.value)}
            hint="Trava de segurança: se uma passagem quiser cortar mais, não corta nenhum e avisa."
          />
        </>
      )}
      <div className="settings-test-whatsapp" aria-label="Teste de ligação ao router">
        <span>{routerMessage || 'Lê a versão do RouterOS para confirmar endereço, credenciais e certificado.'}</span>
        <div className="form-actions">
          {routerFingerprint && (
            <Button
              variant="secondary"
              onClick={onTrustFingerprint}
              leadingIcon={<ShieldCheck size={14} aria-hidden />}
            >
              Confiar neste certificado
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={onRouterTest}
            loading={routerBusy}
            leadingIcon={<Router size={14} aria-hidden />}
          >
            Testar ligação
          </Button>
        </div>
      </div>
    </>
  );
}

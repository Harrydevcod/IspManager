import { AlertTriangle, Check, Minus, Radar, RefreshCw, Router, ShieldCheck, X } from 'lucide-react';
import { Button, Field, Message, Toggle } from '../../components';
import type { SettingsFormState, ToggleField, UpdateField } from './settingsForm';

export type RouterEnforcementState = {
  services: Array<{
    serviceId: number;
    clientName: string;
    username: string;
    online: number;
    divergence: string | null;
    lastError: string | null;
  }>;
  online: number;
  divergences: number;
  enabled: boolean;
  dryRun: boolean;
  configured: boolean;
  autoSuspension?: {
    enabled: boolean;
    dryRun: boolean;
    graceDays: number;
    candidateCount: number;
    blockedByCreditCount: number;
    candidatePercent: number;
    guardTriggered: boolean;
    guardReason: string | null;
  };
};

/** Uma etapa do diagnóstico, tal como o servidor a descreve. */
export type RouterCheck = {
  id: 'config' | 'reach' | 'cert' | 'rest' | 'hardening';
  label: string;
  /** `warn` não falha o teste: a ligação funciona, mas há o que reparar. */
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  command?: string;
  ms?: number;
};

export type RouterTestReport = {
  ok: boolean;
  steps: RouterCheck[];
  version?: string;
  boardName?: string;
  fingerprint?: string | null;
  certificate?: string | null;
  /** Veredicto já escrito. O servidor não o manda: é para os avisos locais. */
  summary?: string;
  tone?: 'neutral' | 'success' | 'error';
};

const CHECK_ICON = {
  ok: Check,
  warn: AlertTriangle,
  fail: X,
  skipped: Minus
} as const;

const DIVERGENCE_LABEL: Record<string, string> = {
  missing_secret: 'Sem utilizador no router',
  state: 'Estado diferente do ISPM',
  profile: 'Perfil PPP diferente do plano',
  password: 'Password PPPoE pendente',
  username: 'Nome PPPoE diferente no router',
  orphan_secret: 'Utilizador sem serviço'
};

type NetworkTabProps = {
  form: SettingsFormState;
  onUpdate: UpdateField;
  onToggle: ToggleField;
  probeBusy: boolean;
  probeMessage: string;
  onProbeNow: () => void;
  routerBusy: boolean;
  /** Relatório da última tentativa, etapa a etapa. Nulo antes do primeiro teste. */
  routerReport: RouterTestReport | null;
  /** Impressão digital lida na última tentativa recusada, para confirmação humana. */
  routerFingerprint: string;
  onRouterTest: () => void;
  onTrustCertificate: () => void;
  onForgetCertificate: () => void;
  routerState: RouterEnforcementState | null;
  enforceBusy: boolean;
  enforceMessage: string;
  onEnforceNow: () => void;
  autoSuspendBusy: boolean;
  autoSuspendMessage: string;
  onAutoSuspendNow: () => void;
};

export function NetworkTab({
  form,
  onUpdate,
  onToggle,
  probeBusy,
  probeMessage,
  onProbeNow,
  routerBusy,
  routerReport,
  routerFingerprint,
  onRouterTest,
  onTrustCertificate,
  onForgetCertificate,
  routerState,
  enforceBusy,
  enforceMessage,
  onEnforceNow,
  autoSuspendBusy,
  autoSuspendMessage,
  onAutoSuspendNow
}: NetworkTabProps) {
  const divergent = (routerState?.services ?? []).filter((row) => row.divergence || row.lastError);
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
        title="Router de gestão do ISP"
        description="O MikroTik da operadora, à cabeça da rede. Liga o ISPM a ele para cortar e repor clientes sozinho, aprovisionar o acesso PPPoE e mostrar quem está mesmo online. Enquanto o ensaio estiver ligado, nada é alterado no router. Não é o router do cliente: o ISPM nunca se liga a equipamento que esteja em casa de alguém."
        checked={form.routerosEnabled}
        onChange={(event) => onToggle('routerosEnabled', event.target.checked)}
      />
      {form.routerosEnabled && (
        <>
          <Field
            label="Endereço do router de gestão"
            value={form.routerosHost}
            onChange={(event) => onUpdate('routerosHost', event.target.value)}
            placeholder="192.168.88.1"
            hint="IP do router da operadora na LAN. O serviço www-ssl tem de estar ligado no RouterOS."
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
            hint="Fica selada nesta máquina e nunca volta a sair em claro. Deixe a máscara como está para manter o que já está guardado."
          />
          <div className="settings-router-cert wide-field">
            <span className="field-label">Certificado do router</span>
            <p>
              {form.routerosTlsCert
                ? 'Fixado. A ligação só é aceite se o router apresentar exatamente este certificado.'
                : 'Nenhum. O router usa certificado próprio: teste a ligação e confirme a impressão digital para o fixar.'}
            </p>
            {form.routerosTlsCert && (
              <Button variant="ghost" onClick={onForgetCertificate}>Esquecer certificado</Button>
            )}
          </div>
          <Toggle
            title="Ensaio (não altera nada no router)"
            description="Calcula tudo o que faria — cortes, reposições, secrets em falta, perfis — e mostra o relatório sem tocar no router. Desligue só depois de conferir o relatório contra o parque real."
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
            hint="Trava da reconciliação: se uma passagem quiser cortar mais, não corta nenhum."
          />
          <Field
            label="Perfil-base dos planos"
            value={form.routerosBaseProfile}
            maxLength={64}
            onChange={(event) => onUpdate('routerosBaseProfile', event.target.value)}
            hint="Perfil PPP que já dá rede aos clientes. Os perfis que o ISPM cria para os planos copiam dele os endereços e o DNS."
          />
          <Toggle
            title="Suspensão automática por falta de pagamento"
            description="Depois da tolerância, suspende apenas o serviço em dívida. O ensaio protege também esta automação: enquanto estiver ligado, só mostra quem seria suspenso."
            checked={form.autoSuspensionEnabled}
            onChange={(event) => onToggle('autoSuspensionEnabled', event.target.checked)}
          />
          {form.autoSuspensionEnabled && (
            <>
              <Field
                label="Dias de tolerância após vencimento"
                type="number"
                min={1}
                max={120}
                value={form.autoSuspensionGraceDays}
                onChange={(event) => onUpdate('autoSuspensionGraceDays', event.target.value)}
                hint="Ex.: vencimento dia 10 + 5 dias de tolerância → elegível para suspensão no dia 16."
              />
              <Field
                label="Verificar cobranças a cada (minutos)"
                type="number"
                min={5}
                max={1440}
                value={form.autoSuspensionIntervalMinutes}
                onChange={(event) => onUpdate('autoSuspensionIntervalMinutes', event.target.value)}
                hint="Também verifica no arranque, para recuperar o período em que o PC esteve desligado."
              />
              <Field
                label="Máximo de suspensões automáticas por passagem"
                type="number"
                min={1}
                max={500}
                value={form.autoSuspensionMaxPerRun}
                onChange={(event) => onUpdate('autoSuspensionMaxPerRun', event.target.value)}
              />
              <Field
                label="Máximo da base ativa por passagem (%)"
                type="number"
                min={1}
                max={100}
                value={form.autoSuspensionMaxPercent}
                onChange={(event) => onUpdate('autoSuspensionMaxPercent', event.target.value)}
                hint="Se qualquer uma das duas travas disparar, nenhum serviço é suspenso."
              />
              <Message tone="neutral">
                {form.routerosDryRun
                  ? 'Ensaio ativo: a cobrança será avaliada, mas o estado do serviço e o MikroTik não serão alterados.'
                  : 'Modo LIVE: pagamentos, créditos e estado são revalidados imediatamente antes de cada suspensão.'}
              </Message>
            </>
          )}
        </>
      )}
      <div className="settings-test-whatsapp" aria-label="Teste de ligação ao router">
        <span>
          Corre o teste por etapas contra os valores acima — não é preciso gravar primeiro.
        </span>
        {routerReport && (
          <>
            <Message tone={routerReport.tone ?? (routerReport.ok ? 'success' : 'error')}>
              {routerReport.summary
                ?? (routerReport.ok
                  ? `Ligado ao ${routerReport.boardName}, RouterOS ${routerReport.version}.`
                  : routerReport.steps.find((step) => step.status === 'fail')?.detail
                    ?? 'Não foi possível contactar o router.')}
            </Message>
            {routerReport.steps.length > 0 && (
            <ol className="settings-router-steps">
              {routerReport.steps.map((step) => {
                const Icon = CHECK_ICON[step.status];
                return (
                  <li key={step.id} data-status={step.status}>
                    <Icon size={14} aria-hidden className="settings-router-step-icon" />
                    <div>
                      <strong>{step.label}</strong>
                      <p>{step.detail}</p>
                      {step.command && <code>{step.command}</code>}
                    </div>
                    <span className="settings-router-step-ms">
                      {step.ms === undefined ? '' : `${step.ms} ms`}
                    </span>
                  </li>
                );
              })}
            </ol>
            )}
          </>
        )}
        {routerFingerprint && (
          <code className="settings-router-fingerprint">
            SHA-256 {routerFingerprint}
          </code>
        )}
        <div className="form-actions">
          {routerFingerprint && (
            <Button
              variant="secondary"
              onClick={onTrustCertificate}
              leadingIcon={<ShieldCheck size={14} aria-hidden />}
              title={`SHA-256 ${routerFingerprint}`}
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

      {routerState?.configured && (
        <section className="settings-router-state wide-field" aria-label="Estado da reconciliação">
          <p className="settings-router-summary">
            {routerState.services.length} serviço(s) com PPPoE · {routerState.online} online agora ·{' '}
            {routerState.divergences} divergência(s)
            {routerState.dryRun ? ' · em ensaio' : ''}
          </p>
          {routerState.autoSuspension?.enabled && (
            <Message tone={routerState.autoSuspension.guardTriggered ? 'error' : 'neutral'}>
              {routerState.autoSuspension.dryRun ? 'Simulação de cobrança: ' : 'Cobrança automática: '}
              {routerState.autoSuspension.candidateCount} serviço(s) elegível(eis) após {routerState.autoSuspension.graceDays} dia(s) de tolerância
              {routerState.autoSuspension.blockedByCreditCount > 0
                ? ` · ${routerState.autoSuspension.blockedByCreditCount} protegido(s) por crédito`
                : ''}
              {routerState.autoSuspension.guardTriggered
                ? ` · TRAVADO: ${routerState.autoSuspension.guardReason}`
                : ''}
            </Message>
          )}
          {divergent.length > 0 && (
            <ul className="settings-router-divergences">
              {divergent.slice(0, 12).map((row) => (
                <li key={row.serviceId}>
                  <strong>{row.clientName}</strong>
                  <span>{row.username}</span>
                  <em>{row.lastError || DIVERGENCE_LABEL[row.divergence ?? ''] || row.divergence}</em>
                </li>
              ))}
            </ul>
          )}
          {form.autoSuspensionEnabled && (
            <div className="settings-test-whatsapp">
              <span>{autoSuspendMessage || 'Avalia agora faturas vencidas, créditos e travas de segurança — respeitando o ensaio.'}</span>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={onAutoSuspendNow}
                  loading={autoSuspendBusy}
                  leadingIcon={<AlertTriangle size={14} aria-hidden />}
                >
                  Avaliar cobrança agora
                </Button>
              </div>
            </div>
          )}
          <div className="settings-test-whatsapp">
            <span>{enforceMessage || 'Compara o ISPM com o router e aplica a diferença — respeitando o ensaio.'}</span>
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={onEnforceNow}
                loading={enforceBusy}
                leadingIcon={<RefreshCw size={14} aria-hidden />}
              >
                Reconciliar agora
              </Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

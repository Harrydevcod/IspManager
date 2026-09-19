import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { NetworkTab, type RouterTestReport } from './NetworkTab';
import type { SettingsFormState } from './settingsForm';

const form = {
  networkProbeEnabled: false,
  networkProbeIntervalSeconds: '60',
  networkProbeIncludeClients: false,
  networkProbeFailThreshold: '3',
  routerosEnabled: true,
  routerosHost: '192.168.88.1',
  routerosPort: '443',
  routerosUser: 'ispm',
  routerosPassword: '••••••••',
  routerosTlsCert: '',
  routerosDryRun: true,
  routerosIntervalSeconds: '120',
  routerosMaxDisablesPerRun: '5'
} as SettingsFormState;

function render(routerReport: RouterTestReport | null) {
  return renderToStaticMarkup(
    <NetworkTab
      form={form}
      onUpdate={vi.fn()}
      onToggle={vi.fn()}
      probeBusy={false}
      probeMessage=""
      onProbeNow={vi.fn()}
      routerBusy={false}
      routerReport={routerReport}
      routerFingerprint=""
      onRouterTest={vi.fn()}
      onTrustCertificate={vi.fn()}
      onForgetCertificate={vi.fn()}
      routerState={null}
      enforceBusy={false}
      enforceMessage=""
      onEnforceNow={vi.fn()}
    />
  );
}

const failedReport: RouterTestReport = {
  ok: false,
  steps: [
    { id: 'config', label: 'Definições do router', status: 'ok', detail: 'ispm@192.168.88.1:443' },
    { id: 'reach', label: 'Porta 192.168.88.1:443', status: 'ok', detail: 'Aberta.', ms: 38 },
    { id: 'cert', label: 'Certificado do router', status: 'ok', detail: 'Fixado e conferido.' },
    {
      id: 'rest',
      label: 'REST API e credenciais',
      status: 'fail',
      detail: 'Utilizador ou senha recusados. Confirme a senha.',
      command: '/user print detail'
    }
  ],
  fingerprint: null,
  certificate: null
};

describe('NetworkTab — diagnóstico do router', () => {
  test('sem relatório mostra só a explicação do botão', () => {
    const html = render(null);
    expect(html).toContain('não é preciso gravar primeiro');
    expect(html).not.toContain('settings-router-steps');
  });

  test('uma falha mostra o motivo e o comando que a resolve', () => {
    const html = render(failedReport);
    expect(html).toContain('Utilizador ou senha recusados');
    expect(html).toContain('/user print detail');
    expect(html).toContain('data-status="fail"');
    // A mensagem tem de ser um <Message> com tom, não texto de dica: era esse
    // o defeito que fazia o teste parecer que não acontecia nada.
    expect(html).toContain('module-message error');
  });

  test('o sucesso diz o modelo e a versão em verde', () => {
    const html = render({
      ok: true,
      steps: failedReport.steps.slice(0, 3),
      version: '7.14.2',
      boardName: 'RB760iGS',
      fingerprint: null,
      certificate: null
    });
    expect(html).toContain('module-message success');
    expect(html).toContain('RB760iGS');
    expect(html).toContain('7.14.2');
  });

  test('um aviso local usa o mesmo painel sem inventar etapas', () => {
    const html = render({ ok: false, steps: [], summary: 'Certificado esquecido.', tone: 'neutral' });
    expect(html).toContain('Certificado esquecido.');
    expect(html).not.toContain('settings-router-steps');
    expect(html).not.toContain('module-message error');
  });
});

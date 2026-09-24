import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { NetworkTab, type RouterEnforcementState, type RouterTestReport } from './NetworkTab';
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
  routerosMaxDisablesPerRun: '5',
  autoSuspensionEnabled: false,
  autoSuspensionGraceDays: '15',
  autoSuspensionIntervalMinutes: '60',
  autoSuspensionMaxPerRun: '5',
  autoSuspensionMaxPercent: '20'
} as SettingsFormState;

function render(routerReport: RouterTestReport | null, routerState: RouterEnforcementState | null = null) {
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
      routerState={routerState}
      enforceBusy={false}
      enforceMessage=""
      onEnforceNow={vi.fn()}
      autoSuspendBusy={false}
      autoSuspendMessage=""
      onAutoSuspendNow={vi.fn()}
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

  test('um aviso amarelo não derruba o veredicto verde', () => {
    // O router responde: o topo tem de continuar a dizer que a ligação funciona.
    // Pintar isto de vermelho seria mentir sobre o que o teste foi lá fazer.
    const html = render({
      ok: true,
      steps: [
        ...failedReport.steps.slice(0, 3),
        { id: 'rest', label: 'REST API e credenciais', status: 'ok', detail: 'hEX S.' },
        {
          id: 'hardening',
          label: 'Serviços abertos no router',
          status: 'warn',
          detail: 'telnet, www — aceitam credenciais em texto simples.',
          command: '/ip service disable telnet,www'
        }
      ],
      version: '7.24.2',
      boardName: 'hEX S',
      fingerprint: null,
      certificate: null
    });
    expect(html).toContain('module-message success');
    expect(html).toContain('data-status="warn"');
    expect(html).toContain('/ip service disable telnet,www');
    expect(html).not.toContain('data-status="fail"');
  });

  test('um aviso local usa o mesmo painel sem inventar etapas', () => {
    const html = render({ ok: false, steps: [], summary: 'Certificado esquecido.', tone: 'neutral' });
    expect(html).toContain('Certificado esquecido.');
    expect(html).not.toContain('settings-router-steps');
    expect(html).not.toContain('module-message error');
  });

  test('mostra a tabela dos clientes que seriam suspensos em ensaio', () => {
    const state: RouterEnforcementState = {
      services: [],
      online: 0,
      divergences: 0,
      enabled: true,
      dryRun: true,
      configured: true,
      autoSuspension: {
        enabled: true,
        dryRun: true,
        graceDays: 5,
        candidateCount: 1,
        blockedByCreditCount: 1,
        candidatePercent: 10,
        guardTriggered: false,
        guardReason: null,
        candidates: [{
          serviceId: 7,
          clientId: 3,
          clientName: 'Joao Silva',
          username: 'joao-7',
          paymentId: 99,
          invoiceNumber: 'FT-99',
          dueDate: '2026-09-10',
          daysOverdue: 9,
          balanceCve: 3000,
          creditCve: 0
        }],
        blockedByCredit: [{
          serviceId: 8,
          clientId: 4,
          clientName: 'Maria Lopes',
          username: 'maria-8',
          paymentId: 100,
          invoiceNumber: 'FT-100',
          dueDate: '2026-09-09',
          daysOverdue: 10,
          balanceCve: 4000,
          creditCve: 500
        }]
      }
    };

    const html = render(null, state);
    expect(html).toContain('Clientes que seriam suspensos');
    expect(html).toContain('Joao Silva');
    expect(html).toContain('joao-7');
    expect(html).toContain('3000 CVE');
    expect(html).toContain('Protegidos por crédito');
    expect(html).toContain('Maria Lopes');
  });

});

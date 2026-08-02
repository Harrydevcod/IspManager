/** @vitest-environment jsdom */

/**
 * O aviso de licença e o painel de Configurações.
 *
 * O que estes testes protegem, acima de tudo: o aviso NÃO é um portão. Mesmo
 * no pior estado a aplicação continua por baixo dele, navegável.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, LicenseBanner, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { LicenseProvider, type LicenseInfo } from '../lib/license';
import { LicensePanel } from './LicensePanel';

let root: Root | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function info(overrides: Partial<LicenseInfo> = {}): LicenseInfo {
  return {
    state: 'active',
    canWrite: true,
    updatesAllowed: true,
    daysRemaining: 300,
    reason: 'Subscrição ativa — Nova Tech, Lda.',
    enabled: true,
    fingerprint: 'a3f21c9d4e5b6a7c8d9e0f1a2b3c4d5e',
    license: {
      id: 'LIC-2026-0007',
      customer: 'Nova Tech, Lda',
      kind: 'subscricao',
      bind: 'none',
      issuedAt: '2026-08-02',
      expiresAt: '2027-08-02',
      maintenanceUntil: null,
      graceDays: 14,
      entitlements: []
    },
    ...overrides
  };
}

let licenseState: LicenseInfo = info();
let activatePayload: string | null = null;

async function mount(children: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <LicenseProvider>
              {children}
              <p data-testid="conteudo">A aplicação continua aqui</p>
            </LicenseProvider>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return container;
}

beforeEach(() => {
  licenseState = info();
  activatePayload = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return json({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/license')) {
      if (init?.method === 'POST') {
        activatePayload = JSON.parse(String(init.body)).token;
        if (activatePayload === 'token-mau') return json({ error: 'A assinatura da licença não confere.' }, 400);
        licenseState = info();
        return json(licenseState);
      }
      if (init?.method === 'DELETE') {
        licenseState = info({ state: 'readonly', canWrite: false, license: null, reason: 'A subscrição expirou.' });
        return json(licenseState);
      }
      return json(licenseState);
    }
    return json({});
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('LicenseBanner', () => {
  test('fica calado quando a licença está em dia', async () => {
    const container = await mount(<LicenseBanner />);
    expect(container.querySelector('.license-banner')).toBeNull();
  });

  test('fica calado quando o licenciamento está desligado', async () => {
    licenseState = info({ enabled: false, state: 'readonly', canWrite: false });
    const container = await mount(<LicenseBanner />);
    expect(container.querySelector('.license-banner')).toBeNull();
  });

  test('avisa em tom de alerta durante a tolerância, sem tapar a aplicação', async () => {
    licenseState = info({
      state: 'grace',
      canWrite: true,
      daysRemaining: -3,
      reason: 'A subscrição expirou há 3 dias.'
    });
    const container = await mount(<LicenseBanner />);

    expect(container.querySelector('.license-banner-warn')).not.toBeNull();
    expect(container.textContent).toContain('A subscrição expirou há 3 dias.');
    expect(container.querySelector('[data-testid="conteudo"]')).not.toBeNull();
  });

  test('sobe para vermelho quando a escrita está bloqueada — e a app continua lá', async () => {
    licenseState = info({ state: 'readonly', canWrite: false, license: null, reason: 'A avaliação terminou.' });
    const container = await mount(<LicenseBanner />);

    expect(container.querySelector('.license-banner-danger')).not.toBeNull();
    // O ponto central do desenho: nunca se tranca o utilizador fora dos dados.
    expect(container.querySelector('[data-testid="conteudo"]')?.textContent).toBe('A aplicação continua aqui');
  });

  test('avisa quando a manutenção de uma perpétua terminou, sem lhe chamar inativa', async () => {
    licenseState = info({
      state: 'active',
      canWrite: true,
      updatesAllowed: false,
      reason: 'A manutenção terminou: a aplicação continua a funcionar, mas deixa de receber atualizações.'
    });
    const container = await mount(<LicenseBanner />);

    expect(container.querySelector('.license-banner-warn')).not.toBeNull();
    expect(container.textContent).toContain('continua a funcionar');
  });
});

describe('ativação', () => {
  test('envia o token colado e apaga o aviso', async () => {
    licenseState = info({ state: 'readonly', canWrite: false, license: null, reason: 'A avaliação terminou.' });
    const container = await mount(<LicenseBanner />);

    const open = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Ativar licença'));
    await act(async () => { open?.click(); await Promise.resolve(); });

    const textarea = document.querySelector('textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '  token-bom  ');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Ativar');
    await act(async () => { submit?.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(activatePayload).toBe('token-bom');
    expect(container.querySelector('.license-banner')).toBeNull();
  });
});

describe('LicensePanel', () => {
  test('mostra a licença, a validade e a identificação da máquina', async () => {
    const container = await mount(<LicensePanel />);

    expect(container.textContent).toContain('Nova Tech, Lda');
    expect(container.textContent).toContain('LIC-2026-0007');
    expect(container.textContent).toContain('02-08-2027');
    expect(container.textContent).toContain('a3f21c9d4e5b6a7c8d9e0f1a2b3c4d5e');
  });

  test('descreve uma perpétua pela manutenção, não por uma validade', async () => {
    licenseState = info({
      license: {
        ...info().license!,
        kind: 'perpetua',
        expiresAt: null,
        maintenanceUntil: '2027-03-31'
      }
    });
    const container = await mount(<LicensePanel />);

    expect(container.textContent).toContain('Perpétua');
    expect(container.textContent).toContain('manutenção até 31-03-2027');
  });

  test('sem licenciamento configurado explica que não há restrições', async () => {
    licenseState = info({ enabled: false });
    const container = await mount(<LicensePanel />);
    expect(container.textContent).toContain('Licenciamento não configurado');
  });
});

/** @vitest-environment jsdom */

/**
 * A confirmação ensaio → efetivo do router: diz em concreto o que passa a
 * acontecer e entrega a password ao gravador sem a deixar ficar no campo.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { RouterLiveDialog } from './RouterLiveDialog';
import type { RouterEnforcementState } from './NetworkTab';
import type { SettingsFormState } from './settingsForm';

let root: Root | null = null;

const form = {
  routerosDryRun: false,
  autoSuspensionEnabled: true,
  autoSuspensionGraceDays: '15',
  autoSuspensionMaxPerRun: '5',
  autoSuspensionMaxPercent: '20'
} as SettingsFormState;

const routerState = {
  services: [],
  online: 40,
  divergences: 3,
  enabled: true,
  dryRun: true,
  configured: true,
  autoSuspension: {
    enabled: true,
    dryRun: true,
    graceDays: 15,
    candidateCount: 2,
    blockedByCreditCount: 0,
    candidatePercent: 4,
    guardTriggered: false,
    guardReason: null
  }
} as RouterEnforcementState;

async function mount(onConfirm: (password: string) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RouterLiveDialog
        open
        form={form}
        routerState={routerState}
        busy={false}
        error={null}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

test('explica o que passa a acontecer, com os números do último ensaio', async () => {
  await mount(vi.fn());
  const text = document.body.textContent ?? '';
  expect(text).toContain('Passar o router a modo efetivo?');
  expect(text).toContain('Corta e repõe o acesso dos clientes');
  expect(text).toContain('Suspende os serviços em dívida há mais de 15 dias');
  expect(text).toContain('até 5 por passagem e nunca mais de 20% da base ativa');
  expect(text).toMatch(/3\s*divergências por aplicar/);
  expect(text).toMatch(/2\s*serviços elegíveis para suspensão/);
});

test('confirmar entrega a password e limpa o campo', async () => {
  const onConfirm = vi.fn();
  await mount(onConfirm);
  const input = document.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'supersecret');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Passar a efetivo');
  await act(async () => { confirm?.click(); });

  expect(onConfirm).toHaveBeenCalledWith('supersecret');
  expect(input.value).toBe('');
});

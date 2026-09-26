// @vitest-environment jsdom
import { StrictMode, act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'vitest';
import { SecretField, type SecretDraft } from './SecretField';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness({ configured = true }: { configured?: boolean }) {
  const [draft, setDraft] = useState<SecretDraft>({ editing: false });
  return <StrictMode><SecretField label="Senha PPPoE" configured={configured} draft={draft} onDraftChange={setDraft} /><button type="button" onClick={() => setDraft({ editing: false })}>Gravar</button></StrictMode>;
}

describe('SecretField', () => {
  test('esconde segredo configurado, edita vazio e cancela', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('Configurada');
    act(() => (host.querySelector('button') as HTMLButtonElement).click());
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    const eye = host.querySelector('[aria-label="Mostrar senha"]') as HTMLButtonElement;
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    act(() => eye.click());
    expect(input.type).toBe('text');
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Cancelar') as HTMLButtonElement).click());
    expect(host.querySelector('input')).toBeNull();
    act(() => (host.querySelector('button') as HTMLButtonElement).click());
    expect(host.querySelector('input')).not.toBeNull();
    act(() => (Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Gravar') as HTMLButtonElement).click());
    expect(host.querySelector('input')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});

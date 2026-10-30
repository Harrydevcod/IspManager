/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { linkStroke, linkSummary } from './link-format';
import { LinkDialog } from './LinkDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('link-format', () => {
  test('o resumo diz o que se sabe e esquece a frequência de um cabo', () => {
    expect(linkSummary(undefined)).toBeNull();
    expect(linkSummary({ medium: 'ptp', fromPort: 'wlan1', toPort: null, frequencyMhz: 5800, capacityMbps: 450, notes: null }))
      .toBe('Rádio PtP · 5800 MHz · 450 Mbps · wlan1 → ?');
    expect(linkSummary({ medium: 'ethernet', fromPort: null, toPort: null, frequencyMhz: 5800, capacityMbps: null, notes: null }))
      .toBe('Ethernet');
  });

  test('o traço muda com o meio', () => {
    expect(linkStroke('fibra').strokeWidth).toBe(3);
    expect(linkStroke('ptp').strokeDasharray).toBe('8 5');
    expect(linkStroke(null)).toEqual({ stroke: 'var(--accent-2)', strokeWidth: 1.8 });
  });
});

describe('LinkDialog', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
  });

  function mount(onSave = vi.fn(), interfaces: string[] | null = null) {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <LinkDialog
          open
          upstream={{ name: 'Router', interfaces }}
          device={{ name: 'Torre', interfaces: null }}
          link={undefined}
          pending={false}
          error={null}
          onSave={onSave}
          onRemove={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
    return onSave;
  }

  function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  }

  const field = (label: string) => [...document.querySelectorAll('label')]
    .find((item) => item.textContent?.startsWith(label))?.querySelector('input, select') as HTMLInputElement | HTMLSelectElement;
  const submit = () => act(() => {
    document.querySelector<HTMLFormElement>('#link-editor-form')!.requestSubmit();
  });

  test('um rádio pede a frequência e grava só números inteiros', () => {
    const onSave = mount();
    expect(field('Frequência')).toBeUndefined();
    act(() => setValue(field('Meio'), 'ptp'));
    act(() => setValue(field('Frequência'), '58OO'));
    submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Frequência');
    expect(onSave).not.toHaveBeenCalled();

    act(() => setValue(field('Frequência'), '5800'));
    act(() => setValue(field('Porta em Torre'), ' wlan1 '));
    submit();
    expect(onSave).toHaveBeenCalledWith({
      medium: 'ptp', fromPort: null, toPort: 'wlan1', frequencyMhz: 5800, capacityMbps: null, notes: null
    });
  });

  test('a porta do router escolhe-se da lista que o router deu', () => {
    mount(vi.fn(), ['ether2', 'ether3']);
    const port = field('Porta em Router');
    expect(port.tagName).toBe('SELECT');
    expect([...(port as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', 'ether2', 'ether3']);
    expect(field('Porta em Torre').tagName).toBe('INPUT');
  });
});

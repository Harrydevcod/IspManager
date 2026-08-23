/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ServiceReturnDialog } from './ServiceReturnDialog';
import type { DeviceAssignment, MaterialReturnLine } from '../../types';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function device(over: Partial<DeviceAssignment> & { id: number }): DeviceAssignment {
  return {
    serviceId: 1,
    catalogId: 10,
    catalogType: 'antena',
    brand: 'TP-Link',
    model: 'CPE 510',
    serialNumber: null,
    assetTag: null,
    ipAddress: null,
    macAddress: null,
    technicianName: null,
    notes: null,
    startDate: '2026-01-10',
    endDate: null,
    createdAt: '2026-01-10',
    isOwner: 1,
    sharedWithNames: null,
    shareCount: 0,
    ownership: 'isp',
    ownedSince: null,
    rentalFeeCve: 250,
    returnCondition: null,
    sellingPriceCve: 6000,
    ...over
  } as DeviceAssignment;
}

const cabo: MaterialReturnLine = {
  catalogId: 30,
  brand: null,
  model: 'Cabo UTP',
  unitOfMeasure: 'm',
  consumed: 50,
  recovered: 10
};

function render(props: Partial<Parameters<typeof ServiceReturnDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  act(() => {
    root.render(
      <ServiceReturnDialog
        clientName="Anilsa"
        assignments={[device({ id: 1 })]}
        materialReturns={[]}
        submitting={false}
        error={null}
        onClose={() => {}}
        onConfirm={onConfirm}
        {...props}
      />
    );
  });
  return { onConfirm };
}

const confirmButton = () =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Registar devolução'))!;

const click = (element: Element) => act(() => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

describe('ServiceReturnDialog', () => {
  test('por omissão devolve tudo em bom estado', () => {
    const { onConfirm } = render({ assignments: [device({ id: 1 }), device({ id: 2 })] });
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      devices: [
        { assignmentId: 1, condition: 'bom' },
        { assignmentId: 2, condition: 'bom' }
      ],
      materials: []
    }));
  });

  test('vindo da linha de uma unidade, só essa entra selecionada', () => {
    const { onConfirm } = render({
      assignments: [device({ id: 1 }), device({ id: 2 })],
      focusAssignmentId: 2
    });
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      devices: [{ assignmentId: 2, condition: 'bom' }]
    }));
  });

  test('o estado escolhido segue no pedido', () => {
    const { onConfirm } = render();
    const select = document.querySelector('select')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!
        .set!.call(select, 'avariado');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      devices: [{ assignmentId: 1, condition: 'avariado' }]
    }));
  });

  test('antena partilhada não pode ser devolvida daqui', () => {
    render({ assignments: [device({ id: 1, shareCount: 1 })] });
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
  });

  test('equipamento do cliente não entra na devolução', () => {
    render({ assignments: [device({ id: 1, ownership: 'cliente', rentalFeeCve: 0 })] });
    expect(document.body.textContent).toContain('fica com ele');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  test('o material recuperado não passa do que ainda falta', () => {
    render({ assignments: [], materialReturns: [cabo] });
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '50');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Consumido 50, já recuperado 10 — o tecto são 40.
    expect(document.body.textContent).toContain('Máximo 40');
    expect(confirmButton().disabled).toBe(true);
  });

  test('material dentro do limite segue com a quantidade', () => {
    const { onConfirm } = render({ assignments: [], materialReturns: [cabo] });
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      devices: [],
      materials: [{ catalogId: 30, quantity: 30 }]
    }));
  });
});

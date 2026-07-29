/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import type { StockCatalogRow, StockSummary } from '../types';
import { StockModule } from './StockModule';

let root: Root | null = null;

const catalog: StockCatalogRow = {
  id: 10,
  category: 'equipamento',
  type: 'router',
  brand: 'MikroTik',
  model: 'CCR2004',
  supplier: 'Fornecedor',
  unitOfMeasure: 'un',
  isSerialized: 1,
  purchasePriceCve: 10_000,
  sellingPriceCve: 15_000,
  rentalFeeCve: 0,
  stockTotal: 2,
  active: 1,
  landedCostCve: 10_000,
  lastMovementAt: null
};

const summary: StockSummary = {
  totals: {
    models: 1,
    available: 2,
    lowStock: 1,
    outOfStock: 0,
    inventoryValueCve: 20_000
  },
  rows: [catalog]
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function mount(props: Parameters<typeof StockModule>[0] = {}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <StockModule {...props} />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) {
      return json({ setupRequired: false, authBypassed: true });
    }
    if (url.endsWith('/api/stock/summary')) return json(summary);
    if (url.endsWith('/api/stock?catalogId=10')) return json({ movements: [] });
    if (url.endsWith('/api/equipment-catalog/10/assignments')) {
      return json({ items: [], activeCount: 0, totalCount: 0 });
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

test('removes backbone quantity from Stock controls, table and catalog form', async () => {
  const container = await mount();

  expect([...container.querySelectorAll('th')]
    .some((header) => header.textContent?.trim() === 'Backbone')).toBe(false);
  expect([...container.querySelectorAll('label')]
    .some((label) => label.textContent?.trim() === 'Uso')).toBe(false);

  const create = [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Novo equipamento');
  if (!create) throw new Error('Create catalog action not found');
  await act(async () => create.click());

  expect([...document.querySelectorAll('label')]
    .some((label) => label.textContent?.trim() === 'Unidades backbone')).toBe(false);
});

test('keeps focusCatalogId navigation after the legacy Stock field is removed', async () => {
  const onCatalogFocusHandled = vi.fn();
  const container = await mount({ focusCatalogId: 10, onCatalogFocusHandled });

  expect(container.textContent).toContain('Equipamento selecionado');
  expect(container.textContent).toContain('MikroTik CCR2004');
  expect(onCatalogFocusHandled).toHaveBeenCalledOnce();
});

test('does not send the removed backbone quantity in catalog payloads', async () => {
  const container = await mount();
  const create = [...container.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Novo equipamento');
  if (!create) throw new Error('Create catalog action not found');
  await act(async () => create.click());

  const modelLabel = [...document.querySelectorAll('label')]
    .find((label) => label.querySelector('.field-label')?.textContent === 'Modelo');
  const model = modelLabel?.querySelector('input');
  if (!model) throw new Error('Model input not found');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setter?.call(model, 'Novo modelo');
    model.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const save = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Gravar equipamento');
  if (!save) throw new Error('Save catalog action not found');
  await act(async () => {
    save.click();
    await Promise.resolve();
  });

  const createCall = vi.mocked(fetch).mock.calls.find(([input, init]) => (
    String(input).endsWith('/api/equipment-catalog') && init?.method === 'POST'
  ));
  if (!createCall) throw new Error('Catalog request not found');
  const payload = JSON.parse(String(createCall[1]?.body)) as Record<string, unknown>;
  expect(payload).not.toHaveProperty('backboneQty');
});

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackbonePage
} from '../../../shared/backbone';
import { BackboneApiError, type BackboneApi } from './backbone-api';
import { BackboneWorkspace } from './BackboneWorkspace';

const backbone: BackboneDeviceSummary = {
  id: 10,
  catalogId: 3,
  catalogBrand: 'Ubiquiti',
  catalogModel: 'Rocket Prism 5AC',
  catalogType: 'radio',
  name: 'Monte Verde',
  status: 'active',
  serialNumber: 'BB-10',
  assetTag: null,
  ipAddress: '10.0.0.10',
  macAddress: null,
  island: 'São Vicente',
  zone: null,
  provisional: false,
  linkedAssignmentCount: 1,
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:00:00.000Z'
};

const destinationBackbone: BackboneDeviceSummary = {
  ...backbone,
  id: 11,
  name: 'Mindelo Sul',
  serialNumber: 'BB-11',
  ipAddress: '10.0.0.11',
  linkedAssignmentCount: 0
};

const unlinkedAssignment: BackboneAssignmentSummary = {
  id: 21,
  catalogId: 4,
  catalogBrand: 'MikroTik',
  catalogModel: 'hAP',
  catalogType: 'router',
  serialNumber: 'CPE-21',
  assetTag: null,
  ipAddress: null,
  macAddress: null,
  startDate: '2026-07-01',
  clientId: 1,
  clientCode: 'CLT-001',
  clientName: 'Cliente Um',
  serviceId: 2,
  serviceStatus: 'active',
  backboneDeviceId: null,
  backboneName: null,
  linkedAt: null
};

const linkedAssignment: BackboneAssignmentSummary = {
  ...unlinkedAssignment,
  id: 22,
  clientCode: 'CLT-002',
  clientName: 'Cliente Dois',
  backboneDeviceId: 10,
  backboneName: 'Monte Verde',
  linkedAt: '2026-07-20T10:00:00.000Z'
};

const secondUnlinkedAssignment: BackboneAssignmentSummary = {
  ...unlinkedAssignment,
  id: 23,
  clientId: 3,
  clientCode: 'CLT-003',
  clientName: 'Cliente Três',
  serviceId: 4,
  serialNumber: 'CPE-23'
};

const detail: BackboneDeviceDetail = {
  ...backbone,
  notes: 'POP principal',
  assignments: [linkedAssignment]
};

function page<T>(items: T[], overrides: Partial<BackbonePage<T>> = {}): BackbonePage<T> {
  return {
    page: 1,
    pageSize: 25,
    total: items.length,
    totalPages: items.length ? 1 : 0,
    items,
    ...overrides
  };
}

let currentRole: 'admin' | 'operator' | 'technician' = 'admin';
let workspaceApi: BackboneApi;

vi.mock('../../lib/auth', () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    isAuthBypassed: false,
    hasRole: (...roles: string[]) => roles.includes(currentRole)
  })
}));

vi.mock('./backbone-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./backbone-api')>();
  return {
    ...original,
    createBackboneApi: () => workspaceApi
  };
});

function api(overrides: Partial<BackboneApi> = {}): BackboneApi {
  return {
    listBackbones: vi.fn(async () => page([backbone])),
    listAssignments: vi.fn(async (query) => page(
      query.mapping === 'unlinked' ? [unlinkedAssignment] : [linkedAssignment, unlinkedAssignment]
    )),
    getBackbone: vi.fn(async () => detail),
    createBackbone: vi.fn(async () => detail),
    updateBackbone: vi.fn(async () => detail),
    linkAssignment: vi.fn(async (id) => ({
      ...unlinkedAssignment,
      id,
      backboneDeviceId: 10,
      backboneName: 'Monte Verde'
    })),
    unlinkAssignment: vi.fn(async (id) => ({ assignmentId: id, backboneDeviceId: null })),
    ...overrides
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWorkspace(
  role: typeof currentRole = 'admin',
  apiOverrides: Partial<BackboneApi> = {},
  props: {
    onMutation?: () => void;
    onViewTopology?: (id: number) => void;
  } = {}
) {
  currentRole = role;
  workspaceApi = api(apiOverrides);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <BackboneWorkspace
        onMutation={props.onMutation ?? (() => undefined)}
        onViewTopology={props.onViewTopology ?? (() => undefined)}
      />
    );
  });
  await flush();
  return host;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.getAttribute('aria-label') === name || element.textContent?.trim() === name);
}

function buttonWithin(rootElement: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...rootElement.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.getAttribute('aria-label') === name || element.textContent?.trim() === name);
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 20; index += 1) {
    if (check()) return;
    await flush();
  }
  expect(check()).toBe(true);
}

async function changeValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
  await act(async () => {
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function debounce() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 330));
  });
}

function labelledControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  label: string
): T {
  const field = [...document.querySelectorAll('label')]
    .find((candidate) => candidate.querySelector('.field-label')?.textContent === label);
  const control = field?.querySelector<T>('input, select, textarea');
  expect(control).toBeTruthy();
  return control!;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Backbone workspace', () => {
  test('exposes the management heading, create action, and factual unlinked state', async () => {
    const container = await renderWorkspace();

    expect(container.querySelector('h1, h2, h3')?.textContent).toContain('Backbone');
    expect(button('Novo backbone')).toBeTruthy();
    expect(container.textContent).toContain('Sem ligação');
  });

  test('keeps list and detail visible for technicians without exposing mutation actions', async () => {
    const container = await renderWorkspace('technician');

    expect(button('Novo backbone')).toBeUndefined();
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => container.textContent?.includes('Número de série') ?? false);

    expect(container.textContent).toContain('Monte Verde');
    expect(button('Ver na Topologia')).toBeTruthy();
    expect(button('Editar')).toBeUndefined();
    expect(button('Ligar equipamentos')).toBeUndefined();
    expect(button('Transferir')).toBeUndefined();
    expect(button('Desligar')).toBeUndefined();
  });

  test('supports keyboard selection and restores focus after a dialog closes', async () => {
    const container = await renderWorkspace();
    const row = container.querySelector<HTMLButtonElement>('[role="option"]');
    row?.focus();

    await act(async () => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });
    await waitFor(() => container.textContent?.includes('Número de série') ?? false);

    expect(container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
    const create = button('Novo backbone')!;
    create.focus();
    await click(create);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(document.querySelector('input[type="number"]'));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(create);
  });

  test('drives backbone search, status, and pagination through server query state', async () => {
    const listBackbones = vi.fn(async (query: Parameters<BackboneApi['listBackbones']>[0]) => page(
      [backbone],
      { page: query.page, total: 50, totalPages: 2 }
    ));
    const container = await renderWorkspace('operator', { listBackbones });

    await click(button('Página seguinte'));
    await debounce();
    expect(listBackbones).toHaveBeenLastCalledWith({
      page: 2,
      pageSize: 25,
      status: undefined,
      query: undefined
    });

    const search = container.querySelector<HTMLInputElement>('input[placeholder^="Nome"]')!;
    await changeValue(search, 'core norte');
    const status = container.querySelector<HTMLSelectElement>('[aria-label="Filtrar por estado"]')!;
    await changeValue(status, 'maintenance');
    await debounce();

    expect(listBackbones).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 25,
      status: 'maintenance',
      query: 'core norte'
    });
  });

  test('creates a backbone from labelled factual identity fields', async () => {
    const onMutation = vi.fn();
    const createBackbone = vi.fn(async () => detail);
    await renderWorkspace('admin', { createBackbone }, { onMutation });

    await click(button('Novo backbone'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Novo backbone');
    await changeValue(labelledControl<HTMLInputElement>('ID do catálogo'), '3');
    await changeValue(labelledControl<HTMLInputElement>('Nome operacional'), 'Monte Verde');
    await changeValue(labelledControl<HTMLInputElement>('Número de série'), 'SN-MV-01');
    await changeValue(labelledControl<HTMLInputElement>('Ilha'), 'São Vicente');
    await click(button('Registar backbone'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);

    expect(createBackbone).toHaveBeenCalledWith({
      catalogId: 3,
      name: 'Monte Verde',
      status: 'active',
      serialNumber: 'SN-MV-01',
      assetTag: null,
      ipAddress: null,
      macAddress: null,
      island: 'São Vicente',
      zone: null,
      notes: null
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('edits the selected backbone with optimistic concurrency identity', async () => {
    const updateBackbone = vi.fn(async () => ({ ...detail, name: 'Monte Verde Norte' }));
    const container = await renderWorkspace('operator', { updateBackbone });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Editar') !== undefined);

    await click(button('Editar'));
    expect(labelledControl<HTMLInputElement>('Nome operacional').value).toBe('Monte Verde');
    await changeValue(labelledControl<HTMLInputElement>('Nome operacional'), 'Monte Verde Norte');
    await click(button('Guardar alterações'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);

    expect(updateBackbone).toHaveBeenCalledWith(10, expect.objectContaining({
      catalogId: 3,
      name: 'Monte Verde Norte',
      expectedUpdatedAt: detail.updatedAt
    }));
  });

  test('marks provisional units and reports missing identity without fabricating values', async () => {
    const provisional: BackboneDeviceDetail = {
      ...detail,
      serialNumber: null,
      assetTag: null,
      ipAddress: null,
      macAddress: null,
      island: null,
      zone: null,
      notes: null,
      provisional: true
    };
    const container = await renderWorkspace('admin', {
      listBackbones: vi.fn(async () => page([provisional])),
      getBackbone: vi.fn(async () => provisional)
    });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => container.textContent?.includes('Número de série') ?? false);

    expect(container.textContent).toContain('Provisório');
    const identityValues = [...container.querySelectorAll('.backbone-facts dd')]
      .map((element) => element.textContent);
    expect(identityValues.filter((value) => value === 'Não informado').length).toBeGreaterThanOrEqual(6);
    expect(container.textContent).not.toContain('Desconhecido');
  });

  test('links multiple unlinked assignments and preserves one mutation notification', async () => {
    const onMutation = vi.fn();
    const linkAssignment = vi.fn(async (id: number) => ({
      ...(id === 21 ? unlinkedAssignment : secondUnlinkedAssignment),
      backboneDeviceId: 10,
      backboneName: 'Monte Verde'
    }));
    const listAssignments = vi.fn(async (query: Parameters<BackboneApi['listAssignments']>[0]) => page(
      query.mapping === 'unlinked'
        ? [unlinkedAssignment, secondUnlinkedAssignment]
        : [linkedAssignment, unlinkedAssignment, secondUnlinkedAssignment]
    ));
    const container = await renderWorkspace(
      'admin',
      { linkAssignment, listAssignments },
      { onMutation }
    );
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Ligar equipamentos') !== undefined);

    await click(button('Ligar equipamentos'));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Sem ligação definida');
    const selections = dialog.querySelectorAll<HTMLInputElement>('.backbone-candidate input[type="checkbox"]');
    expect(selections).toHaveLength(2);
    await click(selections[0]);
    await click(selections[1]);
    expect(dialog.textContent).toContain('2 selecionados');
    await changeValue(labelledControl<HTMLInputElement>('Motivo'), 'Instalação inicial');
    await click(button('Criar ligações'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);

    expect(linkAssignment).toHaveBeenCalledTimes(2);
    expect(linkAssignment).toHaveBeenCalledWith(21, 10, 'Instalação inicial');
    expect(linkAssignment).toHaveBeenCalledWith(23, 10, 'Instalação inicial');
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  test('keeps only failed bulk selections with their server messages after a 409', async () => {
    const linkAssignment = vi.fn(async (id: number) => {
      if (id === 23) throw new BackboneApiError('A ligação foi alterada por outra pessoa', 409);
      return { ...unlinkedAssignment, backboneDeviceId: 10, backboneName: 'Monte Verde' };
    });
    const listAssignments = vi.fn(async (query: Parameters<BackboneApi['listAssignments']>[0]) => page(
      query.mapping === 'unlinked'
        ? [unlinkedAssignment, secondUnlinkedAssignment]
        : [linkedAssignment, unlinkedAssignment, secondUnlinkedAssignment]
    ));
    const container = await renderWorkspace('admin', { linkAssignment, listAssignments });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Ligar equipamentos') !== undefined);
    await click(button('Ligar equipamentos'));

    const dialog = document.querySelector('[role="dialog"]')!;
    const selections = dialog.querySelectorAll<HTMLInputElement>('.backbone-candidate input[type="checkbox"]');
    await click(selections[0]);
    await click(selections[1]);
    await click(button('Criar ligações'));
    await waitFor(() => document.body.textContent?.includes('A ligação foi alterada por outra pessoa') ?? false);

    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    const retained = [...document.querySelectorAll<HTMLInputElement>('.backbone-candidate input[type="checkbox"]')]
      .filter((candidate) => candidate.checked)
      .map((candidate) => candidate.closest('label')?.textContent);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toContain('Cliente Três');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Equipamento #23: A ligação foi alterada por outra pessoa'
    );
  });

  test('transfers a linked assignment to another active backbone', async () => {
    const linkAssignment = vi.fn(async () => ({
      ...linkedAssignment,
      backboneDeviceId: 11,
      backboneName: 'Mindelo Sul'
    }));
    const container = await renderWorkspace('operator', {
      listBackbones: vi.fn(async () => page([backbone, destinationBackbone])),
      linkAssignment
    });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Transferir') !== undefined);
    await click(button('Transferir'));

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Mudança de backbone');
    expect(dialog.querySelector<HTMLInputElement>('.backbone-candidate input')?.checked).toBe(true);
    await changeValue(labelledControl<HTMLSelectElement>('Backbone de destino'), '11');
    await changeValue(labelledControl<HTMLInputElement>('Motivo'), 'Mudança de POP');
    await click(buttonWithin(dialog, 'Transferir'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);

    expect(linkAssignment).toHaveBeenCalledWith(22, 11, 'Mudança de POP');
  });

  test('requires confirmation before unlinking while preserving equipment history', async () => {
    const unlinkAssignment = vi.fn(async (id: number) => ({ assignmentId: id, backboneDeviceId: null }));
    const container = await renderWorkspace('admin', { unlinkAssignment });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Desligar') !== undefined);
    await click(button('Desligar'));

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('O equipamento e o histórico permanecem registados');
    await changeValue(labelledControl<HTMLInputElement>('Motivo'), 'Equipamento removido');
    await click(buttonWithin(dialog, 'Desligar'));
    await waitFor(() => document.querySelector('[role="dialog"]') === null);

    expect(unlinkAssignment).toHaveBeenCalledWith(22, 'Equipamento removido');
  });

  test('retains the edited payload and refreshes affected data after an update conflict', async () => {
    const listBackbones = vi.fn(async () => page([backbone]));
    const getBackbone = vi.fn(async () => detail);
    const updateBackbone = vi.fn(async () => {
      throw new BackboneApiError('O backbone foi alterado por outra pessoa', 409);
    });
    const container = await renderWorkspace('admin', { listBackbones, getBackbone, updateBackbone });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Editar') !== undefined);
    await click(button('Editar'));
    await changeValue(labelledControl<HTMLInputElement>('Nome operacional'), 'Nome ainda por guardar');
    await click(button('Guardar alterações'));
    await waitFor(() => document.body.textContent?.includes('O backbone foi alterado por outra pessoa') ?? false);

    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(labelledControl<HTMLInputElement>('Nome operacional').value).toBe('Nome ainda por guardar');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'O backbone foi alterado por outra pessoa'
    );
    expect(listBackbones).toHaveBeenCalledTimes(2);
    expect(getBackbone).toHaveBeenCalledTimes(2);
  });

  test('uses an explicit second navigation level on narrow viewports', async () => {
    vi.stubGlobal('innerWidth', 600);
    const container = await renderWorkspace();
    const workspaceElement = container.querySelector('.backbone-workspace')!;
    expect(workspaceElement.hasAttribute('data-detail-open')).toBe(false);

    await click(container.querySelector('[role="option"]'));
    await waitFor(() => workspaceElement.getAttribute('data-detail-open') === 'true');
    expect(container.querySelector('.backbone-mobile-back')).toBeTruthy();
    await click(container.querySelector('.backbone-mobile-back'));

    expect(workspaceElement.hasAttribute('data-detail-open')).toBe(false);
    expect(container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('false');
    expect(container.textContent).toContain('Escolha um backbone');
  });

  test('searches link candidates on the independent unlinked server collection', async () => {
    const listAssignments = vi.fn(async (query: Parameters<BackboneApi['listAssignments']>[0]) => page(
      query.mapping === 'unlinked' ? [unlinkedAssignment] : [linkedAssignment, unlinkedAssignment]
    ));
    const container = await renderWorkspace('admin', { listAssignments });
    await click(container.querySelector('[role="option"]'));
    await waitFor(() => button('Ligar equipamentos') !== undefined);
    await click(button('Ligar equipamentos'));

    const search = document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder^="Cliente"]')!;
    await changeValue(search, 'cliente sem pop');
    await debounce();

    expect(listAssignments).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      mapping: 'unlinked',
      query: 'cliente sem pop'
    });
  });
});

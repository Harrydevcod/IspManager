/** @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfirmProvider, ToastProvider } from '../components';
import { AuthProvider } from '../lib/auth';
import { ClientsModule } from './ClientsModule';
import { PlansModule } from './PlansModule';
import { ServicesModule } from './ServicesModule';

/**
 * Catraca: uma célula, um dado, e cada coluna tem cabeçalho. Voltar a empilhar
 * código/nome/telefone numa só célula muda a contagem e parte aqui.
 */

const client = { id: 1, clientCode: 'C0026', fullName: 'Anderson Delgado', phone: '5824326', island: 'São Vicente', zone: 'Espia', status: 'active' };
const service = {
  id: 1, clientId: 1, clientCode: 'C0026', clientName: 'Anderson Delgado', planId: 1, planName: 'Fibra 20', monthlyValueCve: 2500,
  dueDay: 8, status: 'active', activationDate: '2026-01-01', technicalNotes: null, audiovisualMode: 'none',
  audiovisualMonthlyCve: 0, audiovisualAnnualCve: 0, deviceIps: '10.0.0.2', pppoeUsername: null, pppoePassword: null,
  routerOnline: null, routerEnabled: null, routerDivergence: null
};
const plan = {
  id: 1, name: 'Fibra 20', downloadSpeed: '20', uploadSpeed: '20', connectionType: 'fibra', monthlyPriceCve: 2500,
  installationFeeCve: 0, description: null, active: 1, downloadMbps: 20, uploadMbps: 20
};

const cases: Array<{ name: string; render: () => ReactElement; headers: string[] }> = [
  { name: 'Clientes', render: () => <ClientsModule />, headers: ['Código', 'Nome', 'Telefone', 'Ilha', 'Zona', 'Estado', 'Ações'] },
  { name: 'Serviços', render: () => <ServicesModule />, headers: ['Código', 'Cliente', 'Plano', 'Dia venc.', 'IP', 'Mensalidade', 'TV', 'Estado', 'Ações'] },
  { name: 'Planos', render: () => <PlansModule />, headers: ['Nome', 'Tipo', 'Velocidade ↓/↑', 'Preço/mês', 'Router', 'Estado', 'Ações'] }
];

const roots: Root[] = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/auth/status')) return jsonResponse({ setupRequired: false, authBypassed: true });
    if (url.endsWith('/api/clients')) return jsonResponse([client]);
    if (url.endsWith('/api/services')) return jsonResponse([service]);
    if (url.endsWith('/api/plans')) return jsonResponse([plan]);
    if (url.endsWith('/api/audiovisual-config')) return jsonResponse(null);
    return jsonResponse([]);
  }));
});

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.each(cases)('$name', ({ render, headers }) => {
  test('uma coluna por dado, cada uma com o seu cabeçalho', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<AuthProvider><ToastProvider><ConfirmProvider>{render()}</ConfirmProvider></ToastProvider></AuthProvider>);
    });

    const found = [...container.querySelectorAll('[role="columnheader"]')].map((n) => n.textContent?.trim());
    // A coluna da caixa de seleção não tem texto; não é um dado.
    expect(found.filter(Boolean)).toEqual(headers);

    // Todas as colunas de dados ordenam pelo cabeçalho; só "Ações" não.
    const sortable = [...container.querySelectorAll('.data-table-sort')].map((n) => n.textContent?.trim());
    expect(sortable).toEqual(headers.filter((header) => header !== 'Ações'));

    const rows = container.querySelectorAll('.data-table-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelectorAll('[role="cell"]')).toHaveLength(found.length);
  });
});

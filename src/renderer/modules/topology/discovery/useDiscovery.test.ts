/** @vitest-environment jsdom */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDiscovery, type UseDiscovery } from './useDiscovery';
import type { DiscoveryApi, DiscoveryReport } from './discovery-api';

const roots: Root[] = [];

const emptyReport = (over: Partial<DiscoveryReport> = {}): DiscoveryReport => ({
  rows: [],
  counts: { desconhecido: 0, registado: 0, ausente: 0, reservado: 0, duplicado: 0, livre: 0 },
  freeIps: [],
  nextFreeIp: null,
  registeredIps: [],
  rangeSize: 0,
  routerEnriched: false,
  routerConfigured: false,
  ...over
});

function fakeApi(over: Partial<DiscoveryApi> = {}): DiscoveryApi {
  return {
    sweepBatch: vi.fn(async (ips: string[]) => ({
      results: ips.map((ip) => ({ ip, ok: true, rttMs: 3, hostname: null }))
    })),
    fetchContext: vi.fn(async () => emptyReport()),
    assignIp: vi.fn(async () => ({}))
  } as unknown as DiscoveryApi;
}

/**
 * Sonda: expõe o valor do hook a cada render, no estilo dos outros testes.
 *
 * `strict` monta dentro de `<StrictMode>`, que é como a aplicação corre em
 * desenvolvimento: o React faz montar → limpar → montar no mesmo componente.
 * Sem isto, um efeito que se desarme a si próprio na limpeza passa a suite toda
 * e deixa a aba morta na app — foi exatamente o que aconteceu.
 */
async function mountHook(
  active: boolean,
  api: DiscoveryApi,
  options: { strict?: boolean } = {}
): Promise<() => UseDiscovery> {
  let latest: UseDiscovery | null = null;
  function Probe() {
    latest = useDiscovery(active, api);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const tree = options.strict ? createElement(StrictMode, null, createElement(Probe)) : createElement(Probe);
  await act(async () => { root.render(tree); });
  await act(async () => { await Promise.resolve(); });
  return () => {
    if (!latest) throw new Error('hook ainda não montou');
    return latest;
  };
}

/** Deixa correr as promessas encadeadas do varrimento sequencial. */
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
});

afterEach(() => {
  act(() => { roots.splice(0).forEach((root) => root.unmount()); });
  document.body.innerHTML = '';
});

describe('useDiscovery — carregamento inicial', () => {
  test('não pede nada enquanto a aba não estiver ativa', async () => {
    const api = fakeApi();
    await mountHook(false, api);
    await settle(3);
    expect(api.fetchContext).not.toHaveBeenCalled();
  });

  test('ao ativar, lê o contexto uma vez', async () => {
    const api = fakeApi();
    const hook = await mountHook(true, api);
    await settle();
    expect(hook().report).not.toBeNull();
    expect(api.fetchContext).toHaveBeenCalledTimes(1);
  });

  test('sugere o intervalo a partir dos equipamentos registados', async () => {
    const api = fakeApi();
    (api.fetchContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyReport({ registeredIps: ['10.20.30.5', '10.20.30.9'] })
    );
    const hook = await mountHook(true, api);
    await settle();
    expect(hook().range).toBe('10.20.30.1-254');
  });

  test('em StrictMode a montagem dupla não deixa o botão preso a carregar', async () => {
    const api = fakeApi();
    (api.fetchContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyReport({ registeredIps: ['10.20.30.5'] })
    );
    const hook = await mountHook(true, api, { strict: true });
    await settle();

    // O botão "Varrer" recebe `loading` — preso a `true` fica inclicável.
    expect(hook().loading).toBe(false);
    expect(hook().report).not.toBeNull();
    expect(hook().range).toBe('10.20.30.1-254');
  });

  test('um intervalo já usado antes ganha à sugestão', async () => {
    localStorage.setItem('ispm.discovery.range', '172.16.0.1-50');
    const api = fakeApi();
    (api.fetchContext as ReturnType<typeof vi.fn>).mockResolvedValue(
      emptyReport({ registeredIps: ['10.20.30.5'] })
    );
    const hook = await mountHook(true, api);
    await settle();
    expect(hook().range).toBe('172.16.0.1-50');
  });
});

describe('useDiscovery — varrimento', () => {
  test('parte o intervalo em lotes de 64 e chega ao fim', async () => {
    const api = fakeApi();
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('192.168.1.1-100'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    // 100 endereços em lotes de 64 = 2 pedidos.
    expect(api.sweepBatch).toHaveBeenCalledTimes(2);
    expect(hook().scanning).toBe(false);
    expect(hook().progress).toBeNull();
  });

  test('numera os lotes — só o primeiro escreve a linha de auditoria', async () => {
    const api = fakeApi();
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('192.168.1.1-100'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    const indices = (api.sweepBatch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
    expect(indices).toEqual([0, 1]);
  });

  test('entrega ao contexto só os endereços que responderam', async () => {
    const api = fakeApi();
    (api.sweepBatch as ReturnType<typeof vi.fn>).mockImplementation(async (ips: string[]) => ({
      results: ips.map((ip, index) => ({
        ip,
        ok: index === 0,
        rttMs: index === 0 ? 7 : null,
        hostname: null
      }))
    }));
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('192.168.1.1-4'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    const last = (api.fetchContext as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(last?.[0].alive).toEqual([{ ip: '192.168.1.1', rttMs: 7 }]);
    expect(last?.[0].rangeIps).toHaveLength(4);
  });

  test('um intervalo inválido não dispara pedidos e explica-se', async () => {
    const api = fakeApi();
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('10.0.0.0/8'); });
    await act(async () => { hook().scan(); });

    expect(api.sweepBatch).not.toHaveBeenCalled();
    expect(hook().error).toMatch(/demasiado grande/);
    expect(hook().scanning).toBe(false);
  });

  test('parar interrompe a meio e não deita fora o que já respondeu', async () => {
    const api = fakeApi();
    let stop: () => void = () => {};
    let calls = 0;
    (api.sweepBatch as ReturnType<typeof vi.fn>).mockImplementation(async (ips: string[]) => {
      calls += 1;
      if (calls === 1) stop();
      return { results: ips.map((ip) => ({ ip, ok: true, rttMs: 1, hostname: null })) };
    });
    const hook = await mountHook(true, api);
    await settle();
    stop = () => hook().stop();

    await act(async () => { hook().setRange('192.168.1.1-200'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    // 200 endereços dariam 4 lotes; parou depois do primeiro.
    expect(api.sweepBatch).toHaveBeenCalledTimes(1);
    const last = (api.fetchContext as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(last?.[0].alive).toHaveLength(64);
    expect(hook().scanning).toBe(false);
  });

  test('recarregar depois de varrer repete o mesmo intervalo', async () => {
    const api = fakeApi();
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('192.168.1.1-10'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    // Atribuir um IP chama `refresh`: sem o intervalo, a contagem de livres
    // caía a zero logo a seguir a alguém ter varrido.
    await act(async () => { hook().refresh(); });
    await settle();

    const last = (api.fetchContext as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(last?.[0].rangeIps).toHaveLength(10);
    expect(last?.[0].alive).toHaveLength(10);
  });

  test('uma falha a meio é reportada e não deixa a barra presa', async () => {
    const api = fakeApi();
    (api.sweepBatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Router recusou'));
    const hook = await mountHook(true, api);
    await settle();

    await act(async () => { hook().setRange('192.168.1.1-10'); });
    await act(async () => { hook().scan(); });
    await settle(20);

    expect(hook().error).toBe('Router recusou');
    expect(hook().progress).toBeNull();
    expect(hook().scanning).toBe(false);
  });
});

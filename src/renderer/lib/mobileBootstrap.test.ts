import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, setApiTransport } from './apiFetch';
import { initializeMobileTransport } from './mobileBootstrap';

afterEach(() => { setApiTransport(null); vi.unstubAllGlobals(); });

describe('mobile bootstrap', () => {
  it('fails closed when the mobile origin has no native bridge', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('unsafe fallback'));
    vi.stubGlobal('fetch', browserFetch);
    const close = initializeMobileTransport('https://appassets.androidplatform.net', undefined);
    await expect(apiFetch('http://127.0.0.1:3001/api/clients')).rejects.toThrow();
    expect(browserFetch).not.toHaveBeenCalled();
    close();
  });

  it('does not install a bridge on another origin', () => {
    const bridge = {postMessage:vi.fn(), addEventListener:vi.fn(), removeEventListener:vi.fn()};
    initializeMobileTransport('https://example.com', bridge);
    expect(bridge.addEventListener).not.toHaveBeenCalled();
  });

  it('connects backend fetches to the native message channel and removes its listener on close', async () => {
    let listener: ((event: MessageEvent) => void) | undefined;
    const bridge = {
      postMessage: vi.fn((message: string) => {
        const request = JSON.parse(message) as {id:string};
        listener?.({data:JSON.stringify({id:request.id, status:200, headers:{}, body:'b2s='})} as MessageEvent);
      }),
      addEventListener: vi.fn((_type: 'message', callback: (event: MessageEvent) => void) => { listener = callback; }),
      removeEventListener: vi.fn()
    };
    const close = initializeMobileTransport('https://appassets.androidplatform.net', bridge);
    expect(await (await apiFetch('http://127.0.0.1:3001/api/clients')).text()).toBe('ok');
    close();
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
    await expect(apiFetch('http://127.0.0.1:3001/api/clients')).rejects.toThrow();
  });
});

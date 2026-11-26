import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, setApiTransport } from './apiFetch';

afterEach(() => { setApiTransport(null); vi.unstubAllGlobals(); });

describe('backend transport', () => {
  it('uses the installed transport for backend requests, preserving method and headers', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unexpected browser fetch')));
    setApiTransport(transport);
    const headers = new Headers({ Authorization: 'Bearer token' });
    const result = await apiFetch('http://127.0.0.1:3001/api/clients', { method: 'POST', headers, body: '{}' });
    expect(await result.text()).toBe('ok');
    expect(transport).toHaveBeenCalledWith('http://127.0.0.1:3001/api/clients', expect.objectContaining({ method: 'POST', headers, body: '{}' }));
  });

  it('never sends other origins to the backend transport', async () => {
    const transport = vi.fn();
    const browserFetch = vi.fn().mockResolvedValue(new Response('external'));
    vi.stubGlobal('fetch', browserFetch);
    setApiTransport(transport);
    await apiFetch('https://example.com/api/clients');
    expect(transport).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledOnce();
  });

  it('does not fall back to browser networking when the transport fails', async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);
    setApiTransport(() => { throw new Error('transport unavailable'); });
    expect(() => apiFetch('http://127.0.0.1:3001/api/clients')).toThrow('transport unavailable');
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('uses browser fetch when no transport is installed', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response('desktop'));
    vi.stubGlobal('fetch', browserFetch);
    await apiFetch('http://127.0.0.1:3001/health');
    expect(browserFetch).toHaveBeenCalledOnce();
  });
});

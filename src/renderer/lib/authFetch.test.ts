import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch, setAuthFetchToken } from './auth';
import { apiUrl } from './api';

afterEach(() => {
  setAuthFetchToken(null);
  vi.unstubAllGlobals();
});

describe('authFetch', () => {
  it('sends the session token to the ISPM backend', async () => {
    const request = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', request);
    setAuthFetchToken('secret');
    await authFetch(apiUrl('/api/clients'));
    expect(new Headers(request.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer secret');
  });

  it('does not send the session token to another origin', async () => {
    const request = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', request);
    setAuthFetchToken('secret');
    await authFetch('https://example.com/api/clients');
    expect(new Headers(request.mock.calls[0][1].headers).has('Authorization')).toBe(false);
  });

  it.each(['http://127.0.0.1:3002/api/clients', 'http://127.0.0.1.example.com:3001/api/clients', '/api/clients'])(
    'does not infer trust from a similar or relative address: %s',
    async (url) => {
      const request = vi.fn().mockResolvedValue(new Response());
      vi.stubGlobal('fetch', request);
      setAuthFetchToken('secret');
      await authFetch(url);
      expect(new Headers(request.mock.calls[0][1].headers).has('Authorization')).toBe(false);
    }
  );
});

import { describe, expect, it, vi } from 'vitest';
import { createMobileTransport } from './mobileTransport';

describe('mobile transport', () => {
  it('reports a native connection failure as unavailable', async () => {
    let reply!: (value: string) => void;
    const transport = createMobileTransport(message => {
      reply(JSON.stringify({id: JSON.parse(message).id, error: true}));
    }, listener => { reply = listener; return () => {}; });
    await expect(transport.fetch('http://127.0.0.1:3001/api/clients'))
      .rejects.toThrow('Ligação ao computador indisponível');
    transport.close();
  });
  it('transmits an API request and reconstructs a binary response', async () => {
    let reply!: (value: string) => void;
    const send = vi.fn((message: string) => {
      const request = JSON.parse(message);
      expect(request.path).toBe('/api/clients?limit=2');
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe('Bearer token');
      expect(request.body).toBe('e30=');
      reply(JSON.stringify({id:request.id, status:200, headers:{'content-type':'application/octet-stream'}, body:'AAH/'}));
    });
    const transport = createMobileTransport(send, listener => { reply = listener; return () => {}; });
    const response = await transport.fetch('http://127.0.0.1:3001/api/clients?limit=2', {method:'POST', headers:{authorization:'Bearer token'}, body:'{}'});
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 255]);
    transport.close();
  });

  it('rejects pending requests when closed and ignores unknown replies', async () => {
    let reply!: (value: string) => void;
    const transport = createMobileTransport(() => {}, listener => { reply = listener; return () => {}; });
    const pending = transport.fetch('http://127.0.0.1:3001/api/clients');
    reply(JSON.stringify({id:'unknown',status:200,headers:{},body:''}));
    transport.close();
    await expect(pending).rejects.toThrow('Ligação móvel encerrada');
  });

  it('rejects external addresses before sending', async () => {
    const send = vi.fn();
    const transport = createMobileTransport(send, () => () => {});
    await expect(transport.fetch('https://example.com/api/clients')).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    transport.close();
  });

  it('accepts the health check and rejects a request when aborted', async () => {
    const send = vi.fn();
    const transport = createMobileTransport(send, () => () => {});
    const controller = new AbortController();
    const pending = transport.fetch('http://127.0.0.1:3001/health', {signal:controller.signal});
    expect(JSON.parse(send.mock.calls[0][0]).path).toBe('/health');
    controller.abort();
    await expect(pending).rejects.toMatchObject({name:'AbortError'});
    transport.close();
  });
});

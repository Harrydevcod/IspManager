import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchUltraMsgSentMessages, mapAckToStatus, sendDocumentViaUltraMsg, sendViaUltraMsg } from './ultramsg';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  })));
}

describe('sendViaUltraMsg', () => {
  test('captures the message id from the response', async () => {
    stubFetch(200, { sent: 'true', message: 'ok', id: 'true_123@c.us' });
    const result = await sendViaUltraMsg('instance1', 'tok', '+2389912233', 'ola');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toBe('true_123@c.us');
  });

  test('fails when the provider rejects', async () => {
    stubFetch(401, { error: 'bad token' });
    const result = await sendViaUltraMsg('instance1', 'tok', '+2389912233', 'ola');
    expect(result.ok).toBe(false);
  });
});

describe('sendDocumentViaUltraMsg', () => {
  test('posts to /messages/document with filename and base64 document', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sent: 'true', id: 'doc_1' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendDocumentViaUltraMsg('instance1', 'tok', '+2389912233', 'BASE64DATA', 'fatura.pdf', 'A sua fatura');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toBe('doc_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/messages/document');
    const sentBody = (init as { body: URLSearchParams }).body.toString();
    expect(sentBody).toContain('filename=fatura.pdf');
    expect(sentBody).toContain('document=BASE64DATA');
  });
});

describe('fetchUltraMsgSentMessages', () => {
  test('returns the messages array', async () => {
    stubFetch(200, { messages: [{ id: 'a', ack: 'read' }, { id: 'b', ack: 'device' }] });
    const rows = await fetchUltraMsgSentMessages('instance1', 'tok', { limit: 100 });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('returns [] on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await fetchUltraMsgSentMessages('instance1', 'tok')).toEqual([]);
  });
});

describe('mapAckToStatus', () => {
  test('maps known acks', () => {
    expect(mapAckToStatus('read')).toBe('read');
    expect(mapAckToStatus('played')).toBe('read');
    expect(mapAckToStatus('device')).toBe('delivered');
    expect(mapAckToStatus('server')).toBe('sent');
    expect(mapAckToStatus(3)).toBe('read');
    expect(mapAckToStatus(2)).toBe('delivered');
    expect(mapAckToStatus(1)).toBe('sent');
    expect(mapAckToStatus('weird')).toBe('sent');
  });
});

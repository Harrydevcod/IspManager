import { afterEach, describe, expect, test, vi } from 'vitest';
import { sendMetaCloudDocument, sendMetaCloudText } from './meta-cloud';

type Call = { url: string; init: RequestInit };

function stubGraph(...replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const reply = replies[calls.length] ?? replies[replies.length - 1];
    calls.push({ url, init });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => JSON.stringify(reply.body)
    };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendMetaCloudText', () => {
  test('posts a text message with the bearer token and returns the wamid', async () => {
    const calls = stubGraph({ status: 200, body: { messages: [{ id: 'wamid.ABC' }] } });

    const result = await sendMetaCloudText('1055', 'tok', '+2389912233', 'ola');

    expect(result).toEqual({ ok: true, messageId: 'wamid.ABC' });
    expect(calls[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/1055\/messages$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      // A Meta quer so digitos; o outbox guarda o numero com `+`.
      to: '2389912233',
      type: 'text',
      text: { body: 'ola' }
    });
  });

  test('explains the 24h window instead of echoing the raw Graph error', async () => {
    stubGraph({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } });

    const result = await sendMetaCloudText('1055', 'tok', '+2389912233', 'ola');

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain('modelo aprovado');
  });

  test('passes any other Graph error message through', async () => {
    stubGraph({ status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } });

    const result = await sendMetaCloudText('1055', 'bad', '+2389912233', 'ola');

    expect(result).toMatchObject({ ok: false, reason: 'Meta recusou o envio: Invalid OAuth access token' });
  });

  test('a network failure is a failed result, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));

    const result = await sendMetaCloudText('1055', 'tok', '+2389912233', 'ola');

    expect(result).toMatchObject({ ok: false, reason: 'Nao foi possivel contactar a Meta' });
  });
});

describe('sendMetaCloudDocument', () => {
  test('uploads the PDF first, then sends a document message with the media id', async () => {
    const calls = stubGraph(
      { status: 200, body: { id: 'media-77' } },
      { status: 200, body: { messages: [{ id: 'wamid.DOC' }] } }
    );

    const result = await sendMetaCloudDocument('1055', 'tok', '+2389912233', Buffer.from('PDF'), 'fatura.pdf', 'A sua fatura.');

    expect(result).toEqual({ ok: true, messageId: 'wamid.DOC' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/\/1055\/media$/);
    const form = calls[0].init.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect((form.get('file') as File).name).toBe('fatura.pdf');
    expect(calls[1].url).toMatch(/\/1055\/messages$/);
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({
      type: 'document',
      document: { id: 'media-77', filename: 'fatura.pdf', caption: 'A sua fatura.' }
    });
  });

  test('a failed upload stops there: no message is sent', async () => {
    const calls = stubGraph({ status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } });

    const result = await sendMetaCloudDocument('1055', 'tok', '+2389912233', Buffer.from('PDF'), 'fatura.pdf');

    expect(result).toMatchObject({ ok: false, reason: 'Meta recusou o envio: Invalid parameter' });
    expect(calls).toHaveLength(1);
  });
});

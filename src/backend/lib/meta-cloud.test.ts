import { afterEach, describe, expect, test, vi } from 'vitest';
import { listMetaCloudTemplates, sendMetaCloudDocument, sendMetaCloudText, sendMetaCloudTemplate } from './meta-cloud';

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

test('sends an approved template with ordered body parameters', async () => {
  const calls = stubGraph({ status: 200, body: { messages: [{ id: 'wamid.template' }] } });
  const result = await sendMetaCloudTemplate('1055', 'tok', '+2389912233', {
    name: 'aviso_fatura', language: 'pt_PT', params: ['Ana', '2000 CVE']
  });
  expect(result).toEqual({ ok: true, messageId: 'wamid.template' });
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
    to: '2389912233', type: 'template', template: {
      name: 'aviso_fatura', language: { code: 'pt_PT' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '2000 CVE' }] }]
    }
  });
});

test('lists approved templates using the business account and bearer token', async () => {
  const calls = stubGraph({ status: 200, body: { data: [
    { name: 'aviso', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá {{1}}' }] },
    { name: 'pendente', language: 'pt_PT', status: 'PENDING', components: [] }
  ] } });
  const result = await listMetaCloudTemplates('123', 'tok');
  expect(result).toMatchObject({ ok: true, templates: [{ name: 'aviso', language: 'pt_PT', body: 'Olá {{1}}' }] });
  expect(calls[0].url).toContain('/123/message_templates');
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

test('does not expose templates requiring unsupported header or button parameters', async () => {
  stubGraph({ status: 200, body: { data: [
    { name: 'imagem', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }] },
    { name: 'texto', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá' }] }
  ] } });
  expect(await listMetaCloudTemplates('123', 'tok')).toMatchObject({ ok: true, templates: [{ name: 'texto' }] });
});

test('follows a cursor without sending credentials to the paging URL', async () => {
  const calls = stubGraph(
    { status: 200, body: { data: [], paging: { next: 'https://untrusted.example/', cursors: { after: 'cursor-1' } } } },
    { status: 200, body: { data: [{ name: 'aviso', language: 'pt_PT', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá' }] }] } }
  );
  expect(await listMetaCloudTemplates('123', 'tok')).toMatchObject({ ok: true, templates: [{ name: 'aviso' }] });
  expect(calls[1].url).toContain('graph.facebook.com/');
  expect(calls[1].url).toContain('after=cursor-1');
});

test('rejects malformed Graph responses instead of treating them as an empty list', async () => {
  stubGraph({ status: 200, body: { data: null } });
  expect(await listMetaCloudTemplates('123', 'tok')).toMatchObject({ ok: false });
});

test('does not silently return an incomplete template list when pagination is malformed', async () => {
  stubGraph({ status: 200, body: { data: [], paging: { next: 'https://graph.facebook.com/next' } } });
  expect(await listMetaCloudTemplates('123', 'tok')).toMatchObject({ ok: false });
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

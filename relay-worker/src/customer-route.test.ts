import { expect, test, vi } from 'vitest';
import worker from './index';
import { customerScript } from './customer-page';

test('portal routes use an isolated object and reject malformed ids', async () => {
  const fetch = vi.fn(async (_request: Request) => new Response('ciphertext'));
  const idFromName = vi.fn((name: string) => name);
  const env = { MAILBOX: { idFromName, get: () => ({ fetch }) }, CUSTOMER_PORTAL: { idFromName, get: () => ({ fetch }) } };
  const id = 'a'.repeat(64);
  expect((await worker.fetch(new Request(`https://example.test/customer/${id}/snapshot`), env)).status).toBe(200);
  expect(idFromName).toHaveBeenCalledWith(id);
  expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe('/');
  expect((await worker.fetch(new Request('https://example.test/customer/invalid/snapshot'), env)).status).toBe(404);
  const page = await worker.fetch(new Request(`https://example.test/customer/${id}`), env);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  // O link curto (/c#segredo) serve a mesma página, com a mesma CSP.
  const short = await worker.fetch(new Request('https://example.test/c'), env);
  expect(short.status).toBe(200);
  expect(short.headers.get('content-security-policy')).toBe(page.headers.get('content-security-policy'));
  expect(await short.text()).toBe(await page.text());
  expect((await worker.fetch(new Request('https://example.test/c/x'), env)).status).toBe(404);
});

test('the browser script parses without executing', () => {
  expect(() => new Function(customerScript)).not.toThrow();
});

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
});

test('the browser script parses without executing', () => {
  expect(() => new Function(customerScript)).not.toThrow();
});

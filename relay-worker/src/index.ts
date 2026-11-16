import { Mailbox } from './mailbox';
import { CustomerPortal } from './customer-portal';
import { customerPage, customerScript } from './customer-page';

export { Mailbox, CustomerPortal };

type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };
type Env = { MAILBOX: Namespace; CUSTOMER_PORTAL?: Namespace };

/** `/m/<caixa>/...` vai para o Durable Object desse pareamento; o resto não existe. */
export function mailboxRoute(pathname: string): { mailbox: string; path: string } | null {
  const match = /^\/m\/([0-9a-f]{64})(\/[a-z0-9/-]*)$/.exec(pathname);
  return match ? { mailbox: match[1], path: match[2] } : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const security = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
    if (request.method === 'GET' && url.pathname === '/customer-portal.js') return new Response(customerScript, { headers: { ...security, 'content-type': 'text/javascript; charset=utf-8' } });
    if (request.method === 'GET' && /^\/customer\/[0-9a-f]{64}$/.test(url.pathname)) return new Response(customerPage, { headers: { ...security, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } });
    const customer = /^\/customer\/([0-9a-f]{64})\/snapshot$/.exec(url.pathname);
    if (customer) {
      if (!env.CUSTOMER_PORTAL) return new Response(null, { status: 503 });
      url.pathname = '/';
      return env.CUSTOMER_PORTAL.get(env.CUSTOMER_PORTAL.idFromName(customer[1])).fetch(new Request(url, request));
    }
    const route = mailboxRoute(url.pathname);
    if (!route) return new Response(null, { status: 404 });
    url.pathname = route.path;
    return env.MAILBOX.get(env.MAILBOX.idFromName(route.mailbox)).fetch(new Request(url, request));
  }
};

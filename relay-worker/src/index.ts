import { Mailbox } from './mailbox';

export { Mailbox };

type Stub = { fetch(request: Request): Promise<Response> };
type Env = { MAILBOX: { idFromName(name: string): unknown; get(id: unknown): Stub } };

/** `/m/<caixa>/...` vai para o Durable Object desse pareamento; o resto não existe. */
export function mailboxRoute(pathname: string): { mailbox: string; path: string } | null {
  const match = /^\/m\/([0-9a-f]{64})(\/[a-z0-9/-]*)$/.exec(pathname);
  return match ? { mailbox: match[1], path: match[2] } : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = mailboxRoute(url.pathname);
    if (!route) return new Response(null, { status: 404 });
    url.pathname = route.path;
    return env.MAILBOX.get(env.MAILBOX.idFromName(route.mailbox)).fetch(new Request(url, request));
  }
};

import { apiUrl } from './api';
import type { ApiTransport } from './apiFetch';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED = Math.ceil(MAX_BYTES / 3) * 4;
const ALLOWED_HEADERS = new Set(['accept', 'authorization', 'content-type', 'if-match', 'if-none-match', 'range']);

function encode(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  if (text.length > MAX_ENCODED || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Resposta móvel inválida');
  const binary = atob(text);
  if (binary.length > MAX_BYTES) throw new Error('Resposta móvel demasiado grande');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createMobileTransport(send: (message: string) => void, subscribe: (listener: (message: string) => void) => () => void): {fetch: ApiTransport; close: () => void} {
  let closed = false;
  let sequence = 0;
  const pending = new Map<string, {resolve: (response: Response) => void; reject: (error: Error) => void}>();
  const unsubscribe = subscribe(message => {
    try {
      if (message.length > MAX_ENCODED + 8192) return;
      const result: unknown = JSON.parse(message);
      if (!result || typeof result !== 'object') return;
      const value = result as Record<string, unknown>;
      if (typeof value.id !== 'string') return;
      const entry = pending.get(value.id);
      if (!entry) return;
      pending.delete(value.id);
      if (value.error === true) {
        entry.reject(new Error('Ligação ao computador indisponível'));
        return;
      }
      try {
        if (typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || value.status >= 300 && value.status < 400 || typeof value.body !== 'string' || !value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers)) throw new Error('Resposta móvel inválida');
        const bytes = decode(value.body);
        entry.resolve(new Response([204, 205].includes(value.status) ? null : bytes, {status:value.status, headers:value.headers as Record<string, string>}));
      } catch { entry.reject(new Error('Resposta móvel inválida')); }
    } catch { /* Ignore unrelated or malformed messages. */ }
  });
  const fetch: ApiTransport = async (input, init) => {
    if (closed) throw new Error('Ligação móvel encerrada');
    const url = new URL(input);
    if (url.origin !== new URL(apiUrl('')).origin || !(url.pathname.startsWith('/api/') || url.pathname === '/health')) throw new Error('Endereço móvel inválido');
    const request = new Request(input, init);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) throw new Error('Método móvel inválido');
    if (url.pathname === '/health' && request.method !== 'GET') throw new Error('Método móvel inválido');
    if (request.signal.aborted) throw new DOMException('Pedido cancelado', 'AbortError');
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { if (!ALLOWED_HEADERS.has(name)) throw new Error('Cabeçalho móvel inválido'); headers[name] = value; });
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
    if (bytes.length > MAX_BYTES) throw new Error('Pedido móvel demasiado grande');
    if (closed) throw new Error('Ligação móvel encerrada');
    if (request.signal.aborted) throw new DOMException('Pedido cancelado', 'AbortError');
    const id = String(++sequence);
    return new Promise<Response>((resolve, reject) => {
      const abort = () => { pending.delete(id); clearTimeout(timer); reject(new DOMException('Pedido cancelado', 'AbortError')); };
      const timer = setTimeout(() => { pending.delete(id); request.signal.removeEventListener('abort', abort); reject(new Error('Ligação ao computador expirou')); }, 35_000);
      const finish = <T>(fn: (value: T) => void) => (value: T) => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); fn(value); };
      pending.set(id, {resolve:finish(resolve), reject:finish(reject)});
      request.signal.addEventListener('abort', abort, {once:true});
      try { send(JSON.stringify({id, method:request.method, path:url.pathname + url.search, headers, body:encode(bytes)})); }
      catch { const entry = pending.get(id); pending.delete(id); entry?.reject(new Error('Ligação ao computador indisponível')); }
    });
  };
  return {fetch, close: () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const entry of pending.values()) entry.reject(new Error('Ligação móvel encerrada'));
    pending.clear();
  }};
}

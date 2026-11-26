import { inspectMobileClientCertificate } from './mobile-client-certificate';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { MobileTlsIdentity } from './mobile-tls-identity';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'if-match', 'if-none-match', 'range'];
const RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'content-length', 'etag', 'last-modified', 'retry-after', 'content-range', 'accept-ranges']);

export type MobileGatewayRequest = { method: string; url: string; headers: Record<string, string>; body: Buffer; remoteAddress: string };
export type MobileGatewayResponse = { statusCode: number; headers: Record<string, string>; body: Buffer };
export type MobileGatewayOptions = {
  identity: MobileTlsIdentity;
  trustedClientCertificatePem: string;
  /** Compare against the exact client certificate approved by the current pairing, on every request. */
  isDeviceAllowed: (fingerprintSha256: string) => boolean | Promise<boolean>;
  /** False when the server is unconfigured or authentication is bypassed. */
  authReady: () => boolean | Promise<boolean>;
  isUserAuthenticated: (token: string) => boolean | Promise<boolean>;
  dispatch: (request: MobileGatewayRequest) => Promise<MobileGatewayResponse>;
};

function reject(res: ServerResponse, status: number): void {
  res.shouldKeepAlive = false;
  res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store', connection:'close'});
  res.end(JSON.stringify({error: status === 503 ? 'Acesso móvel indisponível' : 'Pedido recusado'}));
}

function peerFingerprint(req: IncomingMessage): string | null {
  try {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    if (!peer.raw) return null;
    return inspectMobileClientCertificate(peer.raw).fingerprintSha256;
  } catch { return null; }
}

function canonicalPath(raw: string): string | null {
  try {
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
    const rawPath = raw.split('?', 1)[0];
    if (/%2f|%5c/i.test(rawPath)) return null;
    const decoded = decodeURIComponent(rawPath);
    if (!(decoded === '/health' || decoded.startsWith('/api/')) || /[%?#\u0000-\u001f\u007f\\]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
    return decoded;
  } catch { return null; }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** Creates an inactive server: the caller must explicitly bind it after pairing. */
export function createMobileGateway(options: MobileGatewayOptions): Server {
  const server = createServer({
    cert: options.identity.certificatePem,
    key: options.identity.privateKeyPem,
    minVersion: 'TLSv1.2',
    requestCert: true,
    ca: options.trustedClientCertificatePem,
    handshakeTimeout: 10_000,
    rejectUnauthorized: true
  }, (req, res) => {
    void (async () => {
      const fingerprint = peerFingerprint(req);
      if (!fingerprint || !await options.isDeviceAllowed(fingerprint)) return reject(res, 403);
      if (!await options.authReady()) return reject(res, 503);
      const method = req.method ?? '';
      const url = req.url ?? '';
      const path = canonicalPath(url);
      if (!METHODS.has(method) || !path || (path === '/health' && method !== 'GET') || path === '/api/auth/setup' || path.startsWith('/api/auth/setup/') || path === '/api/mobile-access' || path.startsWith('/api/mobile-access/')) return reject(res, 403);
      const isLogin = method === 'POST' && path === '/api/auth/login';
      const isStatus = method === 'GET' && path === '/api/auth/status';
      const isHealth = method === 'GET' && path === '/health';
      const auth = req.headers.authorization;
      const authorize = async (): Promise<number | null> => {
        if (!await options.isDeviceAllowed(fingerprint)) return 403;
        if (!await options.authReady()) return 503;
        if (!isLogin && !isStatus && !isHealth && (!auth?.startsWith('Bearer ') || !(await options.isUserAuthenticated(auth.slice(7))))) return 401;
        return null;
      };
      const firstAuthorization = await authorize();
      if (firstAuthorization) return reject(res, firstAuthorization);
      if (req.headersDistinct.authorization && req.headersDistinct.authorization.length !== 1) return reject(res, 400);
      const length = req.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return reject(res, 413);
      let body: Buffer;
      try { body = await readBody(req); } catch { return reject(res, 413); }
      // An upload can outlive its pairing or user session. Recheck before the
      // request reaches the application, including for the login and health routes.
      const beforeDispatch = await authorize();
      if (beforeDispatch) return reject(res, beforeDispatch);
      const headers: Record<string, string> = {};
      for (const name of REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const result = await options.dispatch({method, url, headers, body, remoteAddress:req.socket.remoteAddress ?? ''});
      const beforeResponse = await authorize();
      if (beforeResponse) return reject(res, beforeResponse);
      if (!Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode >= 300 && result.statusCode < 400 || result.statusCode > 599) return reject(res, 502);
      const responseHeaders: Record<string, string> = {'cache-control':'no-store'};
      for (const [name, value] of Object.entries(result.headers)) {
        if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      res.writeHead(result.statusCode, responseHeaders);
      res.end(result.body);
    })().catch(() => { if (!res.headersSent) reject(res, 503); else res.destroy(); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 32;
  server.maxHeadersCount = 64;
  return server;
}

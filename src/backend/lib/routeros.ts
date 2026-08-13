import { request as httpsRequest } from 'node:https';
import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';

/**
 * Cliente REST do RouterOS (v7). Fino de propósito: o ISPM só precisa de listar
 * e mexer em `/ppp/secret` e `/ppp/active`, e uma dependência nova para cinco
 * chamadas HTTP não se paga.
 *
 * Mapeamento de verbos do RouterOS (não é REST convencional):
 *   GET = print · PUT = add · PATCH = set · DELETE = remove · POST = comando
 */

export type RouterConfig = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  dryRun: boolean;
  intervalSeconds: number;
  /** SHA-256 do certificado do router, formato `AA:BB:...`. Vazio = sem pinning. */
  fingerprint: string;
  maxDisablesPerRun: number;
};

export const DEFAULT_ROUTER_PORT = 443;
const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_MAX_DISABLES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- definições

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

function numberSetting(db: Database.Database, key: string, fallback: number, min: number, max: number): number {
  const n = Number(getSetting(db, key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
}

export function readRouterConfig(db: Database.Database): RouterConfig {
  return {
    enabled: getSetting(db, 'routerosEnabled') === 'true',
    host: getSetting(db, 'routerosHost'),
    port: numberSetting(db, 'routerosPort', DEFAULT_ROUTER_PORT, 1, 65535),
    user: getSetting(db, 'routerosUser'),
    password: getSetting(db, 'routerosPassword'),
    // Ausente = ligado. Um dry-run que se desliga sozinho por a chave faltar
    // seria a forma mais estúpida de cortar clientes a sério sem querer.
    dryRun: getSetting(db, 'routerosDryRun') !== 'false',
    intervalSeconds: numberSetting(db, 'routerosIntervalSeconds', DEFAULT_INTERVAL_SECONDS, 30, 3600),
    fingerprint: getSetting(db, 'routerosTlsFingerprint').toUpperCase(),
    maxDisablesPerRun: numberSetting(db, 'routerosMaxDisablesPerRun', DEFAULT_MAX_DISABLES, 1, 500)
  };
}

/** Lido a cada tick pelo agendador, para o intervalo mudar sem reiniciar. */
export function routerosIntervalMs(): number {
  return readRouterConfig(getSqliteDatabase()).intervalSeconds * 1000;
}

export function isRouterConfigured(config: RouterConfig): boolean {
  return Boolean(config.host && config.user);
}

// ------------------------------------------------------------------ erros

export class RouterError extends Error {
  readonly status: number;
  /** Impressão digital lida na ligação, quando o erro foi de certificado. */
  readonly fingerprint?: string;

  constructor(message: string, status = 0, fingerprint?: string) {
    super(message);
    this.name = 'RouterError';
    this.status = status;
    this.fingerprint = fingerprint;
  }
}

// -------------------------------------------------------------- transporte

export type RouterRequest = {
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST';
  path: string;
  body?: unknown;
};

export type RouterTransport = (req: RouterRequest) => Promise<unknown>;

/**
 * Transporte HTTPS.
 *
 * O certificado do RouterOS é auto-assinado por natureza (o router não tem um
 * nome público nem um CA a assiná-lo), por isso a validação de cadeia é
 * substituída — não abandonada — por *pinning*: aceita-se exatamente um
 * certificado, o que o operador confirmou. Sem impressão digital gravada, a
 * validação normal fica em vigor e a ligação falha com a impressão digital lida
 * no erro, para a UI poder oferecer "confiar neste router".
 */
export function createTransport(config: RouterConfig): RouterTransport {
  const auth = `${config.user}:${config.password}`;
  const pinned = config.fingerprint;

  return (req) =>
    new Promise((resolve, reject) => {
      const payload = req.body === undefined ? null : Buffer.from(JSON.stringify(req.body));
      const call = httpsRequest(
        {
          host: config.host,
          port: config.port,
          path: `/rest${req.path}`,
          method: req.method,
          auth,
          rejectUnauthorized: !pinned,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            let parsed: unknown = null;
            if (raw.trim()) {
              try {
                parsed = JSON.parse(raw);
              } catch {
                reject(new RouterError(`Resposta ilegível do router (HTTP ${status})`, status));
                return;
              }
            }
            if (status < 200 || status >= 300) {
              const detail =
                parsed && typeof parsed === 'object' && 'message' in parsed
                  ? String((parsed as { message: unknown }).message)
                  : `HTTP ${status}`;
              reject(new RouterError(status === 401 ? 'Utilizador ou senha recusados pelo router' : detail, status));
              return;
            }
            resolve(parsed);
          });
        }
      );

      if (pinned) {
        call.on('socket', (socket) => {
          socket.on('secureConnect', () => {
            const actual = (socket as import('node:tls').TLSSocket).getPeerCertificate()?.fingerprint256?.toUpperCase() ?? '';
            if (actual !== pinned) {
              call.destroy(
                new RouterError(
                  'O certificado do router não é o que está fixado nas definições. Ligação recusada.',
                  0,
                  actual
                )
              );
            }
          });
        });
      }

      call.on('timeout', () => call.destroy(new RouterError('O router não respondeu a tempo')));
      call.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof RouterError) {
          reject(err);
          return;
        }
        // Cadeia inválida sem pinning: devolve a impressão digital para a UI
        // poder propor fixá-la em vez de mandar o operador desligar o TLS.
        const cert = (call as unknown as { socket?: import('node:tls').TLSSocket }).socket?.getPeerCertificate?.();
        reject(
          new RouterError(
            err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
              ? 'O router usa um certificado próprio. Confirme a impressão digital para confiar nele.'
              : err.message,
            0,
            cert?.fingerprint256?.toUpperCase()
          )
        );
      });

      if (payload) call.write(payload);
      call.end();
    });
}

// ----------------------------------------------------------------- modelo

export type RouterSecret = {
  id: string;
  name: string;
  disabled: boolean;
  profile: string | null;
  rateLimit: string | null;
  comment: string | null;
};

export type RouterActive = {
  id: string;
  name: string;
  address: string | null;
  uptime: string | null;
};

/** RouterOS devolve booleanos como texto ("true"/"yes"). */
function toBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>) : [];
}

// -------------------------------------------------------------- operações

export async function testConnection(transport: RouterTransport): Promise<{ version: string; boardName: string }> {
  const raw = await transport({ method: 'GET', path: '/system/resource?.proplist=version,board-name' });
  const row = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : (raw as Record<string, unknown>);
  return {
    version: str(row?.version) ?? 'desconhecida',
    boardName: str(row?.['board-name']) ?? 'desconhecido'
  };
}

export async function listSecrets(transport: RouterTransport): Promise<RouterSecret[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ppp/secret?.proplist=.id,name,disabled,profile,rate-limit,comment'
  });
  return asArray(raw)
    .map((row) => ({
      id: str(row['.id']) ?? '',
      name: str(row.name) ?? '',
      disabled: toBool(row.disabled),
      profile: str(row.profile),
      rateLimit: str(row['rate-limit']),
      comment: str(row.comment)
    }))
    .filter((secret) => secret.id && secret.name);
}

export async function listActive(transport: RouterTransport): Promise<RouterActive[]> {
  const raw = await transport({ method: 'GET', path: '/ppp/active?.proplist=.id,name,address,uptime' });
  return asArray(raw)
    .map((row) => ({
      id: str(row['.id']) ?? '',
      name: str(row.name) ?? '',
      address: str(row.address),
      uptime: str(row.uptime)
    }))
    .filter((session) => session.name);
}

export type NewSecret = {
  name: string;
  password: string;
  comment: string;
  rateLimit?: string | null;
  profile?: string | null;
};

export async function createSecret(transport: RouterTransport, input: NewSecret): Promise<string> {
  const raw = await transport({
    method: 'PUT',
    path: '/ppp/secret',
    body: {
      name: input.name,
      password: input.password,
      service: 'pppoe',
      comment: input.comment,
      ...(input.rateLimit ? { 'rate-limit': input.rateLimit } : {}),
      ...(input.profile ? { profile: input.profile } : {})
    }
  });
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  return str(row?.['.id']) ?? '';
}

export type SecretPatch = { disabled?: boolean; rateLimit?: string | null; password?: string };

export async function patchSecret(transport: RouterTransport, id: string, patch: SecretPatch): Promise<void> {
  const body: Record<string, string> = {};
  if (patch.disabled !== undefined) body.disabled = patch.disabled ? 'yes' : 'no';
  if (patch.rateLimit !== undefined) body['rate-limit'] = patch.rateLimit ?? '';
  if (patch.password !== undefined) body.password = patch.password;
  if (Object.keys(body).length === 0) return;
  await transport({ method: 'PATCH', path: `/ppp/secret/${id}`, body });
}

/**
 * Derruba a sessão viva. Sem isto, desativar o secret só produz efeito quando o
 * cliente reconectar — pode ficar online durante dias depois de "cortado".
 */
export async function removeActive(transport: RouterTransport, id: string): Promise<void> {
  await transport({ method: 'DELETE', path: `/ppp/active/${id}` });
}

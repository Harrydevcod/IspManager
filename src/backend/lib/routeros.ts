import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { readSecret } from './secrets';

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
  /** Certificado do router em PEM. Vazio = validação normal de cadeia. */
  tlsCert: string;
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
    // Selada na conta do sistema operativo: vem vazia se a base vier de outra
    // máquina, e uma senha vazia falha o teste em vez de ir ao router à sorte.
    password: readSecret(db, 'routerosPassword'),
    // Ausente = ligado. Um dry-run que se desliga sozinho por a chave faltar
    // seria a forma mais estúpida de cortar clientes a sério sem querer.
    dryRun: getSetting(db, 'routerosDryRun') !== 'false',
    intervalSeconds: numberSetting(db, 'routerosIntervalSeconds', DEFAULT_INTERVAL_SECONDS, 30, 3600),
    tlsCert: getSetting(db, 'routerosTlsCert'),
    maxDisablesPerRun: numberSetting(db, 'routerosMaxDisablesPerRun', DEFAULT_MAX_DISABLES, 1, 500)
  };
}

/** Lido a cada tick pelo agendador, para o intervalo mudar sem reiniciar. */
export function routerosIntervalMs(): number {
  return readRouterConfig(getSqliteDatabase()).intervalSeconds * 1000;
}

/**
 * A senha conta: vazia quer dizer também "selada e por abrir nesta conta", e
 * tentar assim só deixa um login recusado no registo do router a cada passagem.
 */
export function isRouterConfigured(config: RouterConfig): boolean {
  return Boolean(config.host && config.user && config.password);
}

// ------------------------------------------------------------------ erros

export class RouterError extends Error {
  readonly status: number;
  /** 'untrusted' quando a ligação caiu por o certificado não ser de confiança. */
  readonly certIssue?: string;
  /**
   * Causa legível por código: o `err.code` do Node (`ECONNREFUSED`) ou
   * `http_401`. É por aqui que `describeRouterFailure` decide o que dizer ao
   * operador — adivinhar pela mensagem partia-se à primeira tradução do Node.
   */
  readonly code: string;

  constructor(message: string, status = 0, certIssue?: string, code = '') {
    super(message);
    this.name = 'RouterError';
    this.status = status;
    this.certIssue = certIssue;
    this.code = code || (status ? `http_${status}` : 'unknown');
  }
}

export type RouterFailure = {
  /** Código estável da causa, para testes e telemetria. */
  code: string;
  /** Uma linha: o que falhou. */
  title: string;
  /** Duas ou três: porquê, e o que conferir. */
  detail: string;
  /** Comando do RouterOS que resolve ou confirma, quando há um. */
  command?: string;
};

/**
 * Traduz a falha para linguagem de quem administra o router.
 *
 * Vive aqui, e não na rota do teste, porque a reconciliação e o job periódico
 * guardam o mesmo erro em `last_error`: `connect ECONNREFUSED 10.0.0.1:443`
 * não diz a ninguém que o que falta é ligar o `www-ssl`. Os comandos são os de
 * `docs/mikrotik-setup.md`.
 */
export function describeRouterFailure(err: unknown): RouterFailure {
  const routerError = err instanceof RouterError ? err : null;
  const nodeCode = (err as NodeJS.ErrnoException | null)?.code;
  const code = routerError?.code || nodeCode || 'unknown';
  const fallback = err instanceof Error ? err.message : 'Falha ao contactar o router';

  switch (code) {
    case 'ECONNREFUSED':
      return {
        code,
        title: 'O router recusou a ligação nessa porta',
        detail:
          'Alguém atendeu e disse que não. Quase sempre é o serviço www-ssl desligado no RouterOS, ou a porta configurada aqui não ser a dele.',
        command: '/ip service enable www-ssl'
      };
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
      return {
        code,
        title: 'O router não respondeu',
        detail:
          'Nada atendeu no endereço indicado. Confirme o IP do router de gestão, que esta máquina chega a essa rede, e que a lista de endereços do www-ssl inclui esta máquina.',
        command: '/ip service print detail where name=www-ssl'
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code,
        title: 'O endereço não existe',
        detail: 'O nome escrito não resolve para nenhum endereço. Use o IP do router na rede de gestão.'
      };
    case 'ECONNRESET':
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return {
        code,
        title: 'A porta responde, mas não fala HTTPS',
        detail:
          'Alguma coisa atende nesse endereço e cortou o aperto de mão TLS. A REST API do RouterOS vive no www-ssl (443), não no www (80).',
        command: '/ip service print detail where name=www-ssl'
      };
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return {
        code,
        title: 'O router usa um certificado próprio',
        detail:
          'É o normal num MikroTik: ninguém assina o certificado dele. Confira a impressão digital abaixo contra a do router e fixe-a — a partir daí a ligação só é aceite com esse certificado.',
        command: '/certificate print detail'
      };
    case 'CERT_MISMATCH':
      return {
        code,
        title: 'O certificado não é o que está fixado',
        detail:
          'O router apresentou um certificado diferente do fixado nas definições. Se o certificado foi mesmo refeito no router, esqueça o antigo e fixe o novo. Se não foi, pare aqui: há alguém pelo meio.',
        command: '/certificate print detail'
      };
    case 'http_401':
      return {
        code,
        title: 'Utilizador ou senha recusados',
        detail:
          'A ligação chegou ao router e ele recusou as credenciais. Confirme a senha e se o utilizador da API está limitado a entrar só de outro endereço.',
        command: '/user print detail'
      };
    case 'http_403':
      return {
        code,
        title: 'O utilizador não tem permissão para a REST API',
        detail:
          'O grupo desse utilizador precisa de rest-api além de read, write e api. Sem rest-api o RouterOS autentica e recusa a seguir.',
        command: '/user group print detail'
      };
    case 'http_404':
      return {
        code,
        title: 'A REST API não existe nesse router',
        detail:
          'O endereço respondeu mas não conhece /rest. A REST API só existe em RouterOS 7 ou superior, e vive no serviço www-ssl.',
        command: '/system resource print'
      };
    default:
      if (code.startsWith('http_5')) {
        return {
          code,
          title: 'O router respondeu com erro interno',
          detail: `O RouterOS devolveu ${code.replace('http_', 'HTTP ')}. Confira os registos do router.`,
          command: '/log print where topics~"error"'
        };
      }
      return { code, title: 'Não foi possível contactar o router', detail: fallback };
  }
}

// -------------------------------------------------------------- transporte

export type RouterRequest = {
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE' | 'POST';
  path: string;
  body?: unknown;
};

export type RouterTransport = (req: RouterRequest) => Promise<unknown>;

export function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256.toUpperCase();
}

function toPem(raw: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Lê o certificado que o router apresenta, **sem enviar credenciais**: só o
 * aperto de mão TLS. É o que permite mostrar a impressão digital ao operador
 * para ele confirmar antes de a fixar.
 *
 * Devolve a **cadeia inteira**, do certificado do router para cima, e não só o
 * dele. O MikroTik assina o certificado do serviço com uma autoridade local
 * (`SKYNET-GW` assinado por `SKYNET-CA`), e o OpenSSL não aceita como âncora de
 * confiança um certificado que não é autoridade: fixar só a folha dava uma
 * ligação que falhava para sempre por "certificado próprio", por mais vezes que
 * se carregasse em confiar. Com a cadeia, a autoridade entra em `ca` e a folha
 * continua a ser o primeiro certificado do PEM — que é o que `fingerprintOf` lê
 * e o que o operador compara contra o router.
 */
export function fetchRouterCertificate(config: RouterConfig): Promise<{ pem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: config.host, port: config.port, rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS },
      () => {
        const leaf = socket.getPeerCertificate(true);
        socket.destroy();
        if (!leaf?.raw) {
          reject(new RouterError('O router nao apresentou certificado', 0, undefined, 'no_cert'));
          return;
        }
        const chain: string[] = [];
        const seen = new Set<string>();
        let node: typeof leaf | undefined = leaf;
        // Uma cadeia auto-assinada aponta o último para si própria: o `seen`
        // é o que impede o ciclo.
        while (node?.raw && !seen.has(node.fingerprint256)) {
          seen.add(node.fingerprint256);
          chain.push(toPem(node.raw));
          node = node.issuerCertificate;
        }
        const pem = chain.join('');
        resolve({ pem, fingerprint: leaf.fingerprint256?.toUpperCase() ?? fingerprintOf(pem) });
      }
    );
    socket.on('timeout', () =>
      socket.destroy(new RouterError('O router nao respondeu a tempo', 0, undefined, 'ETIMEDOUT'))
    );
    socket.on('error', (err: NodeJS.ErrnoException) =>
      reject(err instanceof RouterError ? err : new RouterError(err.message, 0, undefined, err.code))
    );
  });
}

/**
 * Transporte HTTPS.
 *
 * O certificado do RouterOS é auto-assinado por natureza (o router não tem nome
 * público nem um CA que o assine). A verificação de TLS **nunca é desligada**:
 * o certificado que o operador confirmou passa a ser a própria âncora de
 * confiança (`ca`), e a identidade é confirmada em `checkServerIdentity`, que o
 * Node chama *antes* de escrever fosse o que fosse no socket — as credenciais
 * não chegam a sair se o certificado não for exatamente aquele.
 *
 * Sem certificado fixado vale a validação normal de cadeia, e o erro devolve a
 * impressão digital lida para a UI poder propor fixá-la.
 */
export function createTransport(config: RouterConfig): RouterTransport {
  const auth = `${config.user}:${config.password}`;
  const pinnedPem = config.tlsCert.trim();
  const pinnedFingerprint = pinnedPem ? fingerprintOf(pinnedPem) : '';

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
          rejectUnauthorized: true,
          ...(pinnedPem
            ? {
                ca: [pinnedPem],
                // O nome no certificado do router não corresponde a nada
                // resolvível; a identidade aqui é o próprio certificado.
                checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) =>
                  cert.fingerprint256?.toUpperCase() === pinnedFingerprint
                    ? undefined
                    : new RouterError(
                        'O certificado do router nao e o que esta fixado nas definicoes',
                        0,
                        undefined,
                        'CERT_MISMATCH'
                      )
              }
            : {}),
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
                reject(new RouterError(`Resposta ilegível do router (HTTP ${status})`, status, undefined, 'bad_response'));
                return;
              }
            }
            if (status < 200 || status >= 300) {
              // O RouterOS põe a causa em `detail`; o `message` é só a frase
              // do HTTP ("Bad Request"), que sozinha não diz nada ao operador.
              const body = (parsed && typeof parsed === 'object' ? parsed : {}) as { message?: unknown; detail?: unknown };
              const detail =
                [body.message, body.detail].filter((part) => part != null && part !== '').map(String).join(': ')
                || `HTTP ${status}`;
              reject(new RouterError(status === 401 ? 'Utilizador ou senha recusados pelo router' : detail, status));
              return;
            }
            resolve(parsed);
          });
        }
      );

      call.on('timeout', () =>
        call.destroy(new RouterError('O router não respondeu a tempo', 0, undefined, 'ETIMEDOUT'))
      );
      call.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof RouterError) {
          reject(err);
          return;
        }
        const selfSigned =
          err.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
          err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
          err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
        reject(
          new RouterError(
            selfSigned
              ? 'O router usa um certificado próprio. Confirme a impressão digital para confiar nele.'
              : err.message,
            0,
            // Marca para a rota poder ir buscar o certificado (sem credenciais)
            // e propor fixá-lo, em vez de sugerir desligar o TLS.
            selfSigned ? 'untrusted' : undefined,
            err.code
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

/** RouterOS devolve números como texto; o que não vier fica `null`, não zero. */
function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function firstRow(raw: unknown): Record<string, unknown> | undefined {
  return (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
}

export type RouterSystem = {
  identity: string | null;
  version: string | null;
  boardName: string | null;
  architecture: string | null;
  uptime: string | null;
  cpuLoad: number | null;
  freeMemory: number | null;
  totalMemory: number | null;
};

/** Visão geral do equipamento. Leitura pura. */
export async function readSystem(transport: RouterTransport): Promise<RouterSystem> {
  const resource = firstRow(await transport({
    method: 'GET',
    path: '/system/resource?.proplist=version,board-name,architecture-name,uptime,cpu-load,free-memory,total-memory'
  }));
  const identity = firstRow(await transport({ method: 'GET', path: '/system/identity' }));
  return {
    identity: str(identity?.name),
    version: str(resource?.version),
    boardName: str(resource?.['board-name']),
    architecture: str(resource?.['architecture-name']),
    uptime: str(resource?.uptime),
    cpuLoad: num(resource?.['cpu-load']),
    freeMemory: num(resource?.['free-memory']),
    totalMemory: num(resource?.['total-memory'])
  };
}

export type RouterInterface = {
  name: string;
  type: string | null;
  running: boolean;
  disabled: boolean;
  macAddress: string | null;
  rxBytes: number | null;
  txBytes: number | null;
  comment: string | null;
};

/** As interfaces do router. Leitura pura; os contadores são os acumulados desde o arranque. */
export async function listInterfaces(transport: RouterTransport): Promise<RouterInterface[]> {
  const raw = await transport({
    method: 'GET',
    path: '/interface?.proplist=name,type,running,disabled,mac-address,rx-byte,tx-byte,comment'
  });
  return asArray(raw)
    .map((row) => ({
      name: str(row.name) ?? '',
      type: str(row.type),
      running: toBool(row.running),
      disabled: toBool(row.disabled),
      macAddress: str(row['mac-address']),
      rxBytes: num(row['rx-byte']),
      txBytes: num(row['tx-byte']),
      comment: str(row.comment)
    }))
    .filter((item) => item.name);
}

// ------------------------------------------------------------- diagnóstico

export type RouterCheckId = 'config' | 'reach' | 'cert' | 'rest' | 'hardening';

export type RouterCheck = {
  id: RouterCheckId;
  label: string;
  /** `warn` não falha o diagnóstico: a ligação funciona, mas há o que reparar. */
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
  /** Comando do RouterOS que resolve ou confirma esta etapa. */
  command?: string;
  ms?: number;
};

export type RouterDiagnosis = {
  ok: boolean;
  steps: RouterCheck[];
  version?: string;
  boardName?: string;
  /** Impressão digital lida, quando há uma para o operador fixar. */
  fingerprint: string | null;
  certificate: string | null;
};

/**
 * Corre a ligação ao router por etapas, em vez de devolver uma frase só.
 *
 * Uma frase não responde à pergunta que se faz à frente do router: *em que
 * ponto é que isto parte?* Aqui separam-se as quatro coisas que podem estar
 * mal — o que está preenchido, a porta chegar, o certificado ser o certo, e as
 * credenciais serem aceites — e cada uma diz o que conferir.
 *
 * A ordem não é decorativa: as credenciais só saem da máquina depois de o
 * certificado estar conferido. A etapa `reach` usa `fetchRouterCertificate`,
 * que é um aperto de mão **sem credenciais**, e é ela que traz o certificado
 * que a etapa `cert` compara — não há uma segunda ligação para isso.
 */
const HARDENING_LABEL = 'Serviços abertos no router';

/**
 * Última etapa: o router responde, mas está fechado?
 *
 * Custa um GET e responde à pergunta que ninguém se lembra de fazer. **Nunca
 * falha o diagnóstico** — a ligação funciona, e é isso que o `ok` do relatório
 * quer dizer; isto é um aviso. E se a leitura não for possível (o grupo do
 * utilizador podia não ter `read`), fica por testar em vez de inventar um
 * problema.
 *
 * O ISPM **não desliga nada**: dá o comando. Escrever em `/ip/service` podia
 * cortar o winbox ou o ssh do próprio operador e deixá-lo sem caminho de volta
 * ao router. Continua a escrever só em `/ppp/secret` e `/ppp/active` (ADR 0007).
 */
async function fillHardeningStep(step: RouterCheck, transport: RouterTransport): Promise<void> {
  const startedAt = Date.now();
  let services: RouterService[];
  try {
    services = await listServices(transport);
  } catch {
    step.detail = 'Não foi possível ler a lista de serviços do router. O utilizador da API precisa da política `read`.';
    return;
  }

  step.ms = Date.now() - startedAt;
  const findings = auditRouterServices(services);
  if (findings.length === 0) {
    step.status = 'ok';
    step.detail = 'Só está ligado o que é preciso, e limitado à rede de gestão.';
    return;
  }

  // Grave e aviso dão o mesmo amarelo: a diferença está no texto, e pintar de
  // vermelho um router que responde sem problema nenhum de ligação seria mentir
  // sobre o que o teste foi lá fazer.
  step.status = 'warn';
  step.detail = findings.map((finding) => finding.detail).join(' ');
  step.command = findings.map((finding) => finding.command).join('\n');
}

export async function diagnoseRouter(config: RouterConfig): Promise<RouterDiagnosis> {
  const steps: RouterCheck[] = [];
  const skipped = (id: RouterCheckId, label: string, detail = 'Não testado: a etapa anterior falhou.'): RouterCheck => ({
    id,
    label,
    status: 'skipped',
    detail
  });
  const reachLabel = `Porta ${config.host || '?'}:${config.port}`;

  // 1. O que está preenchido. Não vale a pena abrir sockets sem isto.
  const missing: string[] = [];
  if (!config.host) missing.push('endereço');
  if (!config.user) missing.push('utilizador');
  if (!config.password) missing.push('senha');
  if (missing.length > 0) {
    steps.push({
      id: 'config',
      label: 'Definições do router',
      status: 'fail',
      detail: `Falta preencher: ${missing.join(', ')}.`
    });
    steps.push(skipped('reach', reachLabel));
    steps.push(skipped('cert', 'Certificado do router'));
    steps.push(skipped('rest', 'REST API e credenciais'));
    steps.push(skipped('hardening', HARDENING_LABEL));
    return { ok: false, steps, fingerprint: null, certificate: null };
  }
  steps.push({
    id: 'config',
    label: 'Definições do router',
    status: 'ok',
    detail: `${config.user}@${config.host}:${config.port}${config.tlsCert.trim() ? ' · certificado fixado' : ''}`
  });

  // 2. A porta chega e fala TLS — sem enviar credenciais.
  const startedAt = Date.now();
  let presented: { pem: string; fingerprint: string };
  try {
    presented = await fetchRouterCertificate(config);
  } catch (err) {
    const failure = describeRouterFailure(err);
    steps.push({
      id: 'reach',
      label: reachLabel,
      status: 'fail',
      detail: `${failure.title}. ${failure.detail}`,
      command: failure.command,
      ms: Date.now() - startedAt
    });
    steps.push(skipped('cert', 'Certificado do router'));
    steps.push(skipped('rest', 'REST API e credenciais'));
    steps.push(skipped('hardening', HARDENING_LABEL));
    return { ok: false, steps, fingerprint: null, certificate: null };
  }
  steps.push({
    id: 'reach',
    label: reachLabel,
    status: 'ok',
    detail: 'Aberta, e do outro lado responde TLS.',
    ms: Date.now() - startedAt
  });

  // 3. O certificado. Fixado, compara-se; não fixado, decide-se pelo resultado
  //    da etapa seguinte (a cadeia normal ainda pode validar).
  const pinnedPem = config.tlsCert.trim();
  let pinnedFingerprint = '';
  if (pinnedPem) {
    try {
      pinnedFingerprint = fingerprintOf(pinnedPem);
    } catch {
      // PEM ilegível: trata-se abaixo, com instruções.
    }
  }

  const certStep: RouterCheck = {
    id: 'cert',
    label: 'Certificado do router',
    status: 'ok',
    detail: pinnedPem
      ? 'Fixado e conferido: o router apresentou exatamente este certificado.'
      : 'Nenhum fixado. Confira a impressão digital abaixo contra o router e fixe-a para prender a ligação a este equipamento.'
  };
  const restStep: RouterCheck = skipped('rest', 'REST API e credenciais');
  const hardeningStep: RouterCheck = skipped('hardening', HARDENING_LABEL);
  steps.push(certStep, restStep, hardeningStep);

  if (pinnedPem && !pinnedFingerprint) {
    certStep.status = 'fail';
    certStep.detail = 'O certificado fixado nas definições está ilegível. Esqueça-o e fixe outra vez a partir deste teste.';
    return { ok: false, steps, fingerprint: presented.fingerprint, certificate: null };
  }

  if (pinnedPem && pinnedFingerprint !== presented.fingerprint) {
    const failure = describeRouterFailure(new RouterError('', 0, undefined, 'CERT_MISMATCH'));
    certStep.status = 'fail';
    certStep.detail = `${failure.title}. ${failure.detail}`;
    certStep.command = failure.command;
    // Sem `certificate`: fixar o novo com um clique é exatamente o que não se
    // deve poder fazer no dia em que o certificado muda sozinho. Quem quiser
    // trocar passa primeiro por "Esquecer certificado".
    return { ok: false, steps, fingerprint: presented.fingerprint, certificate: null };
  }

  // 4. Credenciais e REST API.
  const restStartedAt = Date.now();
  const transport = createTransport(config);
  try {
    const info = await testConnection(transport);
    if (!pinnedPem) {
      certStep.detail = 'Validado pela cadeia de confiança do sistema. Fixe-o para prender a ligação a este router.';
    }
    restStep.status = 'ok';
    restStep.detail = `${info.boardName}, RouterOS ${info.version}.`;
    restStep.ms = Date.now() - restStartedAt;
    await fillHardeningStep(hardeningStep, transport);
    return {
      ok: true,
      steps,
      version: info.version,
      boardName: info.boardName,
      fingerprint: presented.fingerprint,
      certificate: pinnedPem ? null : presented.pem
    };
  } catch (err) {
    const failure = describeRouterFailure(err);
    // Certificado próprio por confiar: a culpa é da etapa 3, não das
    // credenciais — que, de propósito, nunca chegaram a sair daqui.
    if (err instanceof RouterError && err.certIssue === 'untrusted') {
      certStep.status = 'fail';
      certStep.command = failure.command;
      certStep.detail = pinnedPem
        // Impressão digital certa e mesmo assim sem confiança: o que está
        // fixado é só o certificado do router, sem a autoridade que o assinou.
        // Fixar outra vez a partir deste teste guarda a cadeia completa.
        ? 'O certificado fixado é o do router, mas falta a autoridade que o assinou — e sem ela a ligação nunca é aceite. Carregue em "Confiar neste certificado" para fixar a cadeia completa.'
        : `${failure.title}. ${failure.detail}`;
      restStep.detail = 'Não testado: as credenciais não saem desta máquina enquanto o certificado não for de confiança.';
      return { ok: false, steps, fingerprint: presented.fingerprint, certificate: presented.pem };
    }
    restStep.status = 'fail';
    restStep.detail = `${failure.title}. ${failure.detail}`;
    restStep.command = failure.command;
    restStep.ms = Date.now() - restStartedAt;
    return { ok: false, steps, fingerprint: presented.fingerprint, certificate: pinnedPem ? null : presented.pem };
  }
}

export async function listSecrets(transport: RouterTransport): Promise<RouterSecret[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ppp/secret?.proplist=.id,name,disabled,profile,comment'
  });
  return asArray(raw)
    .map((row) => ({
      id: str(row['.id']) ?? '',
      name: str(row.name) ?? '',
      disabled: toBool(row.disabled),
      profile: str(row.profile),
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

export type RouterService = {
  name: string;
  port: number;
  disabled: boolean;
  /** Restrição de origem, quando existe. Vazio = aceita de toda a rede. */
  address: string | null;
  /** Certificado atribuído ao serviço. Sem ele, um serviço "ssl" não faz TLS. */
  certificate: string | null;
};

/** Os serviços do router. Leitura pura, como o ARP e os vizinhos. */
export async function listServices(transport: RouterTransport): Promise<RouterService[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ip/service?.proplist=name,port,disabled,address,certificate'
  });
  return asArray(raw)
    .map((row) => ({
      name: str(row.name) ?? '',
      port: Number(row.port) || 0,
      disabled: toBool(row.disabled),
      address: str(row.address),
      // O RouterOS escreve literalmente "none" quando não há certificado.
      certificate: str(row.certificate) === 'none' ? null : str(row.certificate)
    }))
    .filter((service) => service.name);
}

export type RouterServiceFinding = {
  /** Serviços envolvidos, pelos nomes do RouterOS. */
  services: string[];
  severity: 'grave' | 'aviso';
  detail: string;
  /** Comando do RouterOS que resolve. */
  command: string;
};

/**
 * Serviços que transportam credenciais em texto simples. O `www` está aqui
 * porque a REST do RouterOS responde nele tal como no `www-ssl`: a mesma API
 * que o ISPM protege com certificado fixado fica disponível ao lado, sem
 * proteção nenhuma, se este ficar ligado.
 */
const CLEARTEXT_SERVICES = ['ftp', 'telnet', 'www', 'api'];

/** Serviços de administração que fazem sentido existir, mas não para toda a rede. */
const SHOULD_BE_RESTRICTED = ['winbox', 'ssh'];

/**
 * Não vazam credenciais, mas também não servem para nada aqui — e o `btest`
 * deixa qualquer um saturar o router à largura de banda toda. Num router que é
 * a cabeça da rede de um ISP, isso é o negócio parado.
 */
const POINTLESS_SERVICES = ['btest'];

/**
 * O que está aberto no router e não devia estar.
 *
 * Função pura de propósito: a classificação é a parte que interessa acertar, e
 * assim testa-se sem router nenhum.
 *
 * **`discover` (MNDP, 5678) nunca é sinalizado.** É dele que sai o
 * `/ip/neighbor`, e o `listNeighbors()` deste mesmo ficheiro é a única fonte de
 * *modelo* de equipamento que não obriga a bater à porta de cada CPE. Desligá-lo
 * cega a descoberta — é exatamente o tipo de linha que alguém "arruma" um dia
 * por parecer supérflua.
 *
 * `www-ssl` também não: é onde a REST vive.
 */
export function auditRouterServices(services: RouterService[]): RouterServiceFinding[] {
  const findings: RouterServiceFinding[] = [];
  // Um nome por serviço: o RouterOS 7.24 devolve o winbox duas vezes, e a
  // lista repetida passava para o texto e para o comando a colar no terminal.
  const seen = new Set<string>();
  const active = services.filter((service) => !service.disabled && !seen.has(service.name) && seen.add(service.name));

  const cleartext = active
    .filter((service) => CLEARTEXT_SERVICES.includes(service.name))
    .map((service) => service.name);
  if (cleartext.length > 0) {
    findings.push({
      services: cleartext,
      severity: 'grave',
      detail: `${cleartext.join(', ')} — aceita${cleartext.length > 1 ? 'm' : ''} credenciais em texto simples. Quem estiver na rede lê a senha ao passar.`,
      command: `/ip service disable ${cleartext.join(',')}`
    });
  }

  // Um serviço "ssl" sem certificado não faz TLS nenhum: está ligado a fingir.
  // O www-ssl fica de fora: é onde a REST do ISPM vive, e esta auditoria só
  // corre depois de o aperto TLS com o certificado fixado ter passado nele.
  // No RouterOS 7.24 a leitura veio sem certificado mesmo assim.
  const fakeTls = active
    .filter((service) => service.name.endsWith('-ssl') && service.name !== 'www-ssl' && !service.certificate)
    .map((service) => service.name);
  if (fakeTls.length > 0) {
    findings.push({
      services: fakeTls,
      severity: 'grave',
      detail: `${fakeTls.join(', ')} — ligado${fakeTls.length > 1 ? 's' : ''} sem certificado atribuído, portanto sem TLS nenhum. O ISPM não usa nenhum destes.`,
      command: `/ip service disable ${fakeTls.join(',')}`
    });
  }

  const pointless = active
    .filter((service) => POINTLESS_SERVICES.includes(service.name))
    .map((service) => service.name);
  if (pointless.length > 0) {
    findings.push({
      services: pointless,
      severity: 'aviso',
      detail: `${pointless.join(', ')} — não serve o ISPM nem a operação, e deixa saturar o router de fora.`,
      command: `/ip service disable ${pointless.join(',')}`
    });
  }

  const unrestricted = active
    .filter((service) => SHOULD_BE_RESTRICTED.includes(service.name) && !service.address)
    .map((service) => service.name);
  if (unrestricted.length > 0) {
    findings.push({
      services: unrestricted,
      severity: 'aviso',
      detail: `${unrestricted.join(', ')} — aceita${unrestricted.length > 1 ? 'm' : ''} ligação de qualquer endereço. Limite à rede de gestão.`,
      command: unrestricted.map((name) => `/ip service set ${name} address=<rede de gestão>`).join('\n')
    });
  }

  return findings;
}

export type RouterArpEntry = {
  address: string;
  macAddress: string | null;
  iface: string | null;
  dynamic: boolean;
};

export type RouterDhcpLease = {
  address: string;
  macAddress: string | null;
  hostName: string | null;
  status: string | null;
};

/**
 * Tabela ARP do **router de gestão do ISP** — o MikroTik à cabeça da rede,
 * configurado em `app_settings`. Nunca o de um cliente.
 *
 * A distinção importa: há clientes com MikroTiks próprios em casa, e esses
 * aparecem na descoberta de rede como equipamentos quaisquer. O ISPM tem um
 * único router configurado e todo o transporte sai de `readRouterConfig` — não
 * há caminho de código que ligue a um equipamento descoberto, e não deve passar
 * a haver.
 *
 * O ARP da máquina onde o ISPM corre só conhece o segmento em que ela está; o
 * do router de gestão conhece todas as redes que encaminha, que é onde vivem os
 * clientes. É leitura pura — não depende de a reconciliação estar ligada nem
 * lhe toca.
 */
export async function listArp(transport: RouterTransport): Promise<RouterArpEntry[]> {
  const raw = await transport({ method: 'GET', path: '/ip/arp?.proplist=address,mac-address,interface,dynamic' });
  return asArray(raw)
    .map((row) => ({
      address: str(row.address) ?? '',
      macAddress: str(row['mac-address']),
      iface: str(row.interface),
      dynamic: toBool(row.dynamic)
    }))
    // Sem MAC é uma entrada falhada: o router perguntou quem tinha o endereço
    // e ninguém respondeu. Basta varrer uma /24 através dele para a tabela
    // ganhar uma destas por cada endereço morto — não prova ninguém na rede.
    .filter((entry) => entry.address && entry.macAddress);
}

/**
 * Concessões DHCP. É a única fonte que traz o nome que o próprio equipamento
 * anuncia (`host-name`) — o DNS inverso raramente responde numa LAN destas.
 */
export type RouterNeighbor = {
  address: string;
  macAddress: string | null;
  identity: string | null;
  /** Quem fabrica: `MikroTik`, ou o que o vizinho anunciar por LLDP. */
  platform: string | null;
  /** O modelo, quando o protocolo o traz: `RB951Ui-2HnD`. */
  board: string | null;
  version: string | null;
  systemDescription: string | null;
};

/**
 * Vizinhos que o router de gestão vê anunciarem-se por MNDP, CDP ou LLDP.
 *
 * É a única fonte de **modelo** que não obriga a tocar em cada equipamento: em
 * vez de bater à porta de 200 CPEs, pergunta-se uma vez a quem já os ouviu
 * apresentarem-se sozinhos. Quem não fala nenhum destes protocolos não aparece
 * aqui — e isso não é uma falha, é a razão de existirem os outros canais.
 *
 * Leitura pura, como `listArp`: não depende de a reconciliação estar ligada.
 */
export async function listNeighbors(transport: RouterTransport): Promise<RouterNeighbor[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ip/neighbor?.proplist=address,mac-address,identity,platform,board,version,system-description'
  });
  return asArray(raw)
    .map((row) => ({
      address: str(row.address) ?? '',
      macAddress: str(row['mac-address']),
      identity: str(row.identity),
      platform: str(row.platform),
      board: str(row.board),
      version: str(row.version),
      systemDescription: str(row['system-description'])
    }))
    .filter((entry) => entry.address);
}

/**
 * O que se mostra como modelo a partir de um vizinho.
 *
 * `board` é o nome da placa e é literalmente o modelo — usa-se tal e qual.
 * Sem ele resta a descrição LLDP, que é texto livre do fabricante: guarda-se
 * porque diz mais do que nada, mas não se tenta extrair um modelo dela à
 * força. `platform` sozinho é fabricante, não modelo, e não passa por modelo.
 */
export function neighborModel(entry: RouterNeighbor): string | null {
  const board = entry.board?.trim();
  if (board) return board;
  const description = entry.systemDescription?.trim();
  if (description) return description.slice(0, 120);
  return null;
}

export async function listDhcpLeases(transport: RouterTransport): Promise<RouterDhcpLease[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ip/dhcp-server/lease?.proplist=address,mac-address,host-name,status'
  });
  return asArray(raw)
    .map((row) => ({
      address: str(row.address) ?? '',
      macAddress: str(row['mac-address']),
      hostName: str(row['host-name']),
      status: str(row.status)
    }))
    .filter((lease) => lease.address);
}

export type NewSecret = {
  name: string;
  password: string;
  comment: string;
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
      ...(input.profile ? { profile: input.profile } : {})
    }
  });
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  return str(row?.['.id']) ?? '';
}

export type SecretPatch = { disabled?: boolean; profile?: string; password?: string; name?: string };

export async function patchSecret(transport: RouterTransport, id: string, patch: SecretPatch): Promise<void> {
  const body: Record<string, string> = {};
  if (patch.disabled !== undefined) body.disabled = patch.disabled ? 'yes' : 'no';
  if (patch.profile !== undefined) body.profile = patch.profile;
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.password !== undefined) body.password = patch.password;
  if (Object.keys(body).length === 0) return;
  await transport({ method: 'PATCH', path: `/ppp/secret/${id}`, body });
}

/**
 * Perfil PPP. É no perfil que o RouterOS guarda a velocidade (`rate-limit`) e
 * os endereços que o cliente recebe; o secret só aponta para ele.
 */
export type RouterProfile = {
  id: string;
  name: string;
  rateLimit: string | null;
  localAddress: string | null;
  remoteAddress: string | null;
  dnsServer: string | null;
  onlyOne: string | null;
  comment: string | null;
};

export async function listProfiles(transport: RouterTransport): Promise<RouterProfile[]> {
  const raw = await transport({
    method: 'GET',
    path: '/ppp/profile?.proplist=.id,name,rate-limit,local-address,remote-address,dns-server,only-one,comment'
  });
  return asArray(raw)
    .map((row) => ({
      id: str(row['.id']) ?? '',
      name: str(row.name) ?? '',
      rateLimit: str(row['rate-limit']),
      localAddress: str(row['local-address']),
      remoteAddress: str(row['remote-address']),
      dnsServer: str(row['dns-server']),
      onlyOne: str(row['only-one']),
      comment: str(row.comment)
    }))
    .filter((profile) => profile.id && profile.name);
}

/**
 * Cria um perfil copiando do base o que faz o cliente ter rede (endereços,
 * DNS, sessão única). Campo a campo e não `copy-from`, que a REST não prova.
 */
export async function createProfile(
  transport: RouterTransport,
  input: { name: string; rateLimit: string; comment: string; base: RouterProfile }
): Promise<string> {
  const { base } = input;
  const raw = await transport({
    method: 'PUT',
    path: '/ppp/profile',
    body: {
      name: input.name,
      'rate-limit': input.rateLimit,
      comment: input.comment,
      ...(base.localAddress ? { 'local-address': base.localAddress } : {}),
      ...(base.remoteAddress ? { 'remote-address': base.remoteAddress } : {}),
      ...(base.dnsServer ? { 'dns-server': base.dnsServer } : {}),
      ...(base.onlyOne ? { 'only-one': base.onlyOne } : {})
    }
  });
  const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  return str(row?.['.id']) ?? '';
}

export async function patchProfile(transport: RouterTransport, id: string, patch: { rateLimit: string }): Promise<void> {
  await transport({ method: 'PATCH', path: `/ppp/profile/${id}`, body: { 'rate-limit': patch.rateLimit } });
}

/**
 * Derruba a sessão viva. Sem isto, desativar o secret só produz efeito quando o
 * cliente reconectar — pode ficar online durante dias depois de "cortado".
 */
export async function removeActive(transport: RouterTransport, id: string): Promise<void> {
  await transport({ method: 'DELETE', path: `/ppp/active/${id}` });
}

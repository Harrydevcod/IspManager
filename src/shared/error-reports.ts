import type { DataCollection } from '@sentry/core';

/**
 * Relatórios de erro (Sentry). Desligados por omissão: o operador liga-os em
 * Configurações → Automatismos. Mesmo ligados, nenhum dado de cliente sai — só a
 * stack, a versão e o sistema operativo.
 *
 * O DSN não é segredo (vai em todos os instaladores). Vazio = nunca arranca.
 */
export const SENTRY_DSN = '';

/** Argumento que o main passa ao renderer, lido pelo preload. */
export const ERROR_REPORTS_ARG = '--ispm-error-reports';

/**
 * Integrações por omissão do SDK que levam dados para fora:
 * - minidumps (SentryMinidump, ElectronMinidump): o dump nativo leva memória do processo;
 * - Screenshots: capturas do ecrã;
 * - Console: os console.* da app mencionam clientes e endereços;
 * - LocalVariables: valores das variáveis em cada frame.
 * Por padrão e não por nome exato: o SDK já mudou estes nomes entre versões.
 */
const DROPPED_INTEGRATION = /minidump|screenshot|^console$|localvariables/i;

export function keepIntegration(name: string): boolean {
  return !DROPPED_INTEGRATION.test(name);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// NIF (9 dígitos), telefones (7+), contas e NIB: qualquer número longo.
// O ponto não separa, para os endereços IP (192.168.2.1) ficarem: são o diagnóstico.
const LONG_NUMBER = /\d[\d\s-]{5,}\d/g;

/** Tira e-mails e números longos de um texto livre (mensagem de erro, breadcrumb). */
export function scrubText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[número]');
}

/** URL sem query nem fragmento: `/api/clients?search=Maria` → `/api/clients`. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

const URL_LIKE = /^(https?:\/\/|\/)/;
const QUERY_KEYS = new Set(['http.query', 'http.fragment', 'url.query', 'url.fragment']);

/** Limpa os campos com forma de URL de um objeto de dados (breadcrumb, span). */
export function scrubData<T extends Record<string, unknown> | undefined>(data: T): T {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (QUERY_KEYS.has(key)) continue;
    out[key] = typeof value === 'string' && URL_LIKE.test(value) ? stripQuery(value) : value;
  }
  return out as T;
}

type Crumb = { category?: string; message?: string; data?: Record<string, unknown> };

export function scrubBreadcrumb<T extends Crumb>(crumb: T): T | null {
  // O texto escrito ou clicado na interface é dado de cliente.
  if (crumb.category === 'ui.input') return null;
  // console.* do renderer chegam como breadcrumbs mesmo sem a integração Console do main.
  if (crumb.category === 'console') return null;
  if (crumb.category === 'ui.click') delete crumb.message;
  if (crumb.message) crumb.message = scrubText(crumb.message);
  crumb.data = scrubData(crumb.data);
  return crumb;
}

type ScrubbableEvent = {
  message?: string;
  transaction?: string;
  user?: unknown;
  server_name?: string;
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; query_string?: unknown; cookies?: unknown; data?: unknown; headers?: unknown };
  breadcrumbs?: Crumb[];
  extra?: unknown;
  spans?: { data?: Record<string, unknown>; description?: string }[];
  contexts?: { trace?: { data?: Record<string, unknown> } };
};

/** Último filtro antes de sair: corre em erros e transações, do main e do renderer. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  delete event.user;
  delete event.server_name;
  delete event.extra;
  if (event.message) event.message = scrubText(event.message);
  if (event.transaction) event.transaction = stripQuery(event.transaction);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubText(value.value);
  }
  if (event.request) {
    if (event.request.url) event.request.url = stripQuery(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb)).filter((c): c is Crumb => c !== null);
  }
  const trace = event.contexts?.trace;
  if (trace) trace.data = scrubData(trace.data);
  for (const span of event.spans ?? []) {
    span.data = scrubData(span.data);
    if (span.description) span.description = scrubText(stripQuery(span.description.replace(/[?#]\S*/g, '')));
  }
  return event;
}

/** Opções comuns ao main e ao renderer. */
export const DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false
};

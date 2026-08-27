import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';

import type { ModelSource } from './network-discovery';

/**
 * Perguntar a um equipamento **que aparelho é ele**.
 *
 * O fabricante já se sabe de graça pelo OUI do MAC, mas o OUI diz "TP-Link
 * Technologies" e nunca "CPE710". O modelo só se sabe perguntando, e há duas
 * formas de perguntar que não exigem credenciais nenhumas:
 *
 * - **SNMP `sysDescr`** — um datagrama, e a resposta é o aparelho a descrever-se
 *   a si próprio. É a melhor: não há interpretação pelo meio.
 * - **Banner HTTP** — o título da página de login e o cabeçalho `Server`. Custa
 *   uma ligação TCP e é interpretação de HTML, que muda quando o firmware muda
 *   de tema.
 *
 * Tenta-se SNMP primeiro por ser mais barato *e* melhor — quando responde, nem
 * se chega a bater à porta do servidor web.
 *
 * Tudo aqui é leitura e anónimo: nunca se envia uma credencial, nunca se faz
 * POST, nunca se segue um redirecionamento.
 */

export const SNMP_PORT = 161;
export const SNMP_COMMUNITY = 'public';
export const PROBE_TIMEOUT_MS = 1500;
/** Chega e sobra para apanhar `<title>`; o resto da página não interessa. */
const MAX_BODY_BYTES = 16 * 1024;

// ------------------------------------------------------------------- SNMP

/** `1.3.6.1.2.1.1.1.0` — sysDescr.0, já em BER. O primeiro byte é `1*40+3`. */
const OID_SYS_DESCR = Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]);

function berLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), berLength(value.length), value]);
}

function berInteger(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  // Bit alto ligado leria como negativo em complemento para dois.
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

/**
 * Um GetRequest SNMPv2c por um único OID.
 *
 * Escrito à mão em vez de trazer uma dependência: um pedido de um escalar são
 * quatro TLVs encaixados, e a alternativa era uma biblioteca inteira de SNMP
 * para mandar sempre o mesmo datagrama.
 */
export function buildSnmpGet(requestId: number, community = SNMP_COMMUNITY): Buffer {
  const varbind = tlv(0x30, Buffer.concat([tlv(0x06, OID_SYS_DESCR), tlv(0x05, Buffer.alloc(0))]));
  const pdu = tlv(
    0xa0,
    Buffer.concat([berInteger(requestId), berInteger(0), berInteger(0), tlv(0x30, varbind)])
  );
  return tlv(
    0x30,
    Buffer.concat([berInteger(1), tlv(0x04, Buffer.from(community, 'latin1')), pdu])
  );
}

type Tlv = { tag: number; value: Buffer; next: number };

function readTlv(buffer: Buffer, offset: number): Tlv | null {
  if (offset + 2 > buffer.length) return null;
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  let length = first;
  let start = offset + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || start + count > buffer.length) return null;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer[start + i];
    start += count;
  }
  if (start + length > buffer.length) return null;
  return { tag, value: buffer.subarray(start, start + length), next: start + length };
}

function readChildren(buffer: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  for (;;) {
    const node = readTlv(buffer, offset);
    if (!node) break;
    out.push(node);
    offset = node.next;
  }
  return out;
}

/**
 * Tira o `sysDescr` de uma resposta SNMP. `null` para qualquer coisa que não
 * seja exatamente uma resposta bem formada com uma cadeia lá dentro — um
 * datagrama truncado ou um erro do agente não podem virar nome de modelo.
 */
export function parseSnmpString(packet: Buffer): string | null {
  const message = readTlv(packet, 0);
  if (!message || message.tag !== 0x30) return null;

  const [, , pdu] = readChildren(message.value);
  if (!pdu || pdu.tag !== 0xa2) return null; // 0xA2 = GetResponse

  const [, errorStatus, , varbindList] = readChildren(pdu.value);
  if (!errorStatus || errorStatus.value.some((byte) => byte !== 0)) return null;
  if (!varbindList) return null;

  const varbind = readChildren(varbindList.value)[0];
  if (!varbind) return null;

  const [, value] = readChildren(varbind.value);
  if (!value || value.tag !== 0x04) return null;

  const text = value.value.toString('latin1').replace(/\s+/g, ' ').trim();
  return text || null;
}

export function snmpSysDescr(ip: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* já fechado */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    // Só distingue esta pergunta de outra em voo; não é segredo nenhum.
    const requestId = 1 + Math.floor(Math.random() * 0x7ffffffe);

    socket.on('message', (packet) => finish(parseSnmpString(packet)));
    socket.on('error', () => finish(null));
    socket.send(buildSnmpGet(requestId), SNMP_PORT, ip, (error) => {
      if (error) finish(null);
    });
  });
}

// ------------------------------------------------------------------- HTTP

export type HttpBanner = {
  scheme: 'http' | 'https';
  status: number;
  server: string | null;
  /** `WWW-Authenticate: Basic realm="…"` — muito equipamento põe o modelo aqui. */
  realm: string | null;
  title: string | null;
};

export function parseTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = match[1].replace(/\s+/g, ' ').trim();
  return text || null;
}

export function parseRealm(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /realm\s*=\s*"([^"]{1,120})"/i.exec(header);
  return match ? match[1].trim() || null : null;
}

function requestBanner(ip: string, scheme: 'http' | 'https', timeoutMs: number): Promise<HttpBanner | null> {
  return new Promise((resolve) => {
    const client = scheme === 'https' ? https : http;
    let settled = false;
    const finish = (result: HttpBanner | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = client.request(
      {
        host: ip,
        port: scheme === 'https' ? 443 : 80,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        // Estes equipamentos servem certificados auto-assinados e não há CA
        // nenhuma que os cubra. Aceita-se porque **nada sai** por esta ligação:
        // é um GET anónimo cujo único produto é uma etiqueta para leitura
        // humana. Onde há segredos em jogo — o router de gestão — mantém-se o
        // pinning de certificado que `routeros.ts` faz.
        rejectUnauthorized: false,
        agent: false
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) response.destroy();
        });
        const done = () => {
          const header = response.headers['server'];
          finish({
            scheme,
            status: response.statusCode ?? 0,
            server: (Array.isArray(header) ? header[0] : header)?.trim() || null,
            realm: parseRealm(response.headers['www-authenticate'] as string | undefined),
            title: parseTitle(Buffer.concat(chunks).toString('latin1'))
          });
        };
        response.on('end', done);
        response.on('close', done);
        response.on('error', () => finish(null));
      }
    );

    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
    request.end();
  });
}

export async function readHttpBanner(ip: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<HttpBanner | null> {
  // 80 primeiro: a esmagadora maioria destes equipamentos serve lá, e poupa-se
  // o aperto de mão TLS quando responde.
  return (await requestBanner(ip, 'http', timeoutMs)) ?? (await requestBanner(ip, 'https', timeoutMs));
}

/**
 * Assinaturas que transformam um banner em nome de modelo.
 *
 * **Esta tabela escreve-se a partir do que a rede real respondeu, nunca de
 * memória.** Um mapa de fabricantes escrito de cabeça já acertou 0 em 54 neste
 * projeto e foi deitado fora; escrever aqui palpites sobre firmware seria o
 * mesmo erro com outra roupa. Corre-se `scripts/probe-models.cjs` contra a
 * rede, olha-se para as respostas, e só então se acrescenta uma linha.
 *
 * Até lá o canal HTTP não inventa modelo nenhum — guarda o banner em bruto no
 * `model_detail`, que é exatamente a prova de que esta tabela precisa.
 */
export const HTTP_SIGNATURES: Array<{ test: RegExp; model: (match: RegExpExecArray) => string }> = [];

export function modelFromBanner(banner: HttpBanner): string | null {
  const haystack = [banner.title, banner.realm, banner.server].filter(Boolean).join(' | ');
  for (const signature of HTTP_SIGNATURES) {
    const match = signature.test.exec(haystack);
    if (match) return signature.model(match);
  }
  return null;
}

export function describeBanner(banner: HttpBanner): string {
  return [
    `${banner.scheme} ${banner.status}`,
    banner.title && `title=${banner.title}`,
    banner.realm && `realm=${banner.realm}`,
    banner.server && `server=${banner.server}`
  ]
    .filter(Boolean)
    .join(' | ');
}

// ------------------------------------------------------------ orquestração

export type ModelProbe = {
  /** `null` = ninguém soube dizer o modelo, mas o `detail` pode explicar porquê. */
  model: string | null;
  source: ModelSource;
  detail: string | null;
};

export type IdentifyDeps = {
  snmp?: (ip: string) => Promise<string | null>;
  http?: (ip: string) => Promise<HttpBanner | null>;
};

export async function identifyModel(ip: string, deps: IdentifyDeps = {}): Promise<ModelProbe | null> {
  const snmp = deps.snmp ?? ((target: string) => snmpSysDescr(target));
  const sysDescr = await snmp(ip);
  if (sysDescr) {
    // O `sysDescr` é o aparelho a apresentar-se: usa-se como está, cortado só
    // ao que cabe numa linha de tabela.
    return { model: sysDescr.slice(0, 120), source: 'snmp', detail: sysDescr };
  }

  const readBanner = deps.http ?? ((target: string) => readHttpBanner(target));
  const banner = await readBanner(ip);
  if (!banner) return null;

  return { model: modelFromBanner(banner), source: 'http', detail: describeBanner(banner) };
}

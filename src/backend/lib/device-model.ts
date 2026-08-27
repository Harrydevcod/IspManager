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
 * - **Banner HTTP** — título, `WWW-Authenticate` e o princípio da página. Custa
 *   uma ligação TCP e é interpretação de HTML, que muda quando o firmware muda
 *   de tema.
 *
 * Os dois correm ao mesmo tempo e o SNMP ganha se responder. Começou por ser em
 * série — perguntar ao exato e só depois ao interpretado — até a rede real
 * mostrar que o SNMP responde em **0 de 42** equipamentos deste parque: esperar
 * pelo silêncio dele pagava-se em cada endereço sem comprar nada.
 *
 * Tudo aqui é leitura e anónimo: nunca se envia uma credencial, nunca se faz
 * POST, nunca se segue um redirecionamento.
 */

export const SNMP_PORT = 161;
export const SNMP_COMMUNITY = 'public';
export const PROBE_TIMEOUT_MS = 1500;
/** Chega e sobra para apanhar `<title>`; o resto da página não interessa. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * Quanto do corpo se guarda para as assinaturas lerem. No parque real o
 * `productInfo` dos Pharos aparece antes dos 500 bytes; 4 KB dá folga para
 * firmware que empurre o cabeçalho da página para baixo, sem carregar meia
 * página de JavaScript para memória por cada equipamento.
 */
const BODY_HEAD_BYTES = 4 * 1024;

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
  /**
   * O princípio da página. Existe porque o parque real obrigou: os CPE da TP-Link
   * têm todos o título "Pharos" — o nome do sistema, igual em toda a gama — e o
   * modelo só aparece numa variável de JavaScript no corpo.
   */
  bodyHead: string;
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
          const body = Buffer.concat(chunks).toString('latin1');
          finish({
            scheme,
            status: response.statusCode ?? 0,
            server: (Array.isArray(header) ? header[0] : header)?.trim() || null,
            realm: parseRealm(response.headers['www-authenticate'] as string | undefined),
            title: parseTitle(body),
            bodyHead: body.slice(0, BODY_HEAD_BYTES)
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

/** Uma resposta que não traz título nem realm não disse nada sobre o aparelho. */
function saysSomething(banner: HttpBanner | null): banner is HttpBanner {
  return Boolean(banner && (banner.title || banner.realm));
}

/** O pedido é injetável para os testes não precisarem de abrir sockets. */
export type BannerRequest = (ip: string, scheme: 'http' | 'https', timeoutMs: number) => Promise<HttpBanner | null>;

export async function readHttpBanner(
  ip: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  request: BannerRequest = requestBanner
): Promise<HttpBanner | null> {
  // 80 primeiro: a esmagadora maioria destes equipamentos serve lá, e poupa-se
  // o aperto de mão TLS quando responde.
  const plain = await request(ip, 'http', timeoutMs);
  if (saysSomething(plain)) return plain;

  // Responder e não dizer nada não é o mesmo que não responder. Há equipamento
  // — as NanoStation do parque, por exemplo — cujo `:80` é só um 302 de corpo
  // vazio a mandar para o `:443`, onde está a página verdadeira. Parar no
  // primeiro que responde deixava esses por identificar para sempre.
  const secure = await request(ip, 'https', timeoutMs);
  return saysSomething(secure) ? secure : (plain ?? secure);
}

/**
 * O quarto valor do `productInfo` dos CPE da TP-Link → modelo.
 *
 * **Derivado do parque real, não de documentação.** A varredura de 2026-08-27
 * encontrou 18 CPE: 16 com o código 276, todos registados como CPE 510, e 2 com
 * o código 620, ambos registados como CPE710. Partição exata, sem uma exceção.
 *
 * O cabeçalho `Server` parecia servir para o mesmo e não serve: dividia o parque
 * em 13 e 5, que não é a divisão dos modelos — é a da versão do firmware. Ter
 * ido pelo caminho óbvio dava um mapa errado com todo o ar de estar certo.
 *
 * Um código que não esteja aqui não se adivinha: diz-se o código, para que a
 * linha que falta se possa acrescentar com a mesma prova que estas duas têm.
 */
const PHAROS_PRODUCT_CODES: Record<string, string> = {
  '276': 'CPE510',
  '620': 'CPE710'
};

/**
 * Assinaturas que transformam um banner em nome de modelo.
 *
 * **Escritas a partir do que a rede real respondeu, nunca de memória.** Um mapa
 * de fabricantes escrito de cabeça já acertou 0 em 54 neste projeto e foi
 * deitado fora. Para acrescentar uma linha aqui: correr
 * `scripts/probe-models.cjs`, olhar para as respostas, e confirmar contra o
 * registo — foi assim que estas nasceram.
 *
 * A ordem conta. A dos Pharos vem primeiro porque a página deles também tem
 * texto que as outras regras apanhariam.
 */
export const HTTP_SIGNATURES: Array<{ test: RegExp; model: (match: RegExpExecArray) => string }> = [
  {
    // O título diz só "Pharos" — o nome do sistema, igual em toda a gama. O
    // modelo está numa variável de JavaScript no corpo da página.
    test: /var\s+productInfo\s*=\s*new\s+Array\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*\d+\s*,\s*(\d+)/,
    model: (match) => PHAROS_PRODUCT_CODES[match[1]] ?? `Pharos (código ${match[1]})`
  },
  {
    // Os switches e conversores da TP-Link põem a referência no próprio título.
    // Ancorado ao início: o título é sempre a primeira parcela do `haystack`,
    // portanto isto nunca apanha um "TL-" perdido no meio de uma página.
    test: /^(TL-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?=\s|\||$)/,
    model: (match) => match[1]
  },
  {
    // O router da Starlink. Não é um modelo, é o que ele responde ser — e é
    // mais do que "Wi-Fi" para quem está a olhar para a linha.
    test: /^Starlink(?=\s|\||$)/,
    model: () => 'Starlink'
  }
];

export function modelFromBanner(banner: HttpBanner): string | null {
  // As parcelas vazias mantêm-se para o `^` das assinaturas se referir sempre
  // ao título e a mais nada.
  const haystack = [banner.title ?? '', banner.realm ?? '', banner.server ?? '', banner.bodyHead]
    .join(' | ');
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

/**
 * Os dois canais correm **ao mesmo tempo**, não um a seguir ao outro.
 *
 * Em série parecia melhor: perguntar primeiro ao canal exato e só bater à porta
 * do servidor web se ele calasse. A rede real desfez a ideia — no parque medido
 * o SNMP respondeu em 0 de 42 equipamentos, portanto a espera pelo silêncio
 * dele pagava-se em cada endereço e não comprava nada. Em paralelo custa o mais
 * lento dos dois em vez da soma, e o SNMP continua a ganhar onde existir.
 */
export async function identifyModel(ip: string, deps: IdentifyDeps = {}): Promise<ModelProbe | null> {
  const snmp = deps.snmp ?? ((target: string) => snmpSysDescr(target));
  const readBanner = deps.http ?? ((target: string) => readHttpBanner(target));

  const [sysDescr, banner] = await Promise.all([snmp(ip), readBanner(ip)]);

  if (sysDescr) {
    // O `sysDescr` é o aparelho a apresentar-se: usa-se como está, cortado só
    // ao que cabe numa linha de tabela.
    return { model: sysDescr.slice(0, 120), source: 'snmp', detail: sysDescr };
  }

  if (!banner) return null;

  return { model: modelFromBanner(banner), source: 'http', detail: describeBanner(banner) };
}

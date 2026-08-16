/**
 * Expansão de um intervalo de IPv4 escrito à mão para a lista de endereços a
 * varrer.
 *
 * Vive em `src/shared` porque é preciso dos dois lados: o renderer expande o
 * intervalo para saber quantos lotes vai enviar (e desenhar a barra de
 * progresso), o backend valida o que recebe. Duas implementações do mesmo
 * parser seriam duas oportunidades de discordarem sobre o que é um /24.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Teto de segurança. Um /22 já são ~17 minutos de espera no pior caso (todos os
 * endereços mortos, 1 s de timeout, 32 em voo); acima disto o utilizador não
 * queria varrer, enganou-se na máscara.
 */
export const MAX_SWEEP_HOSTS = 1024;

/** Endereços por pedido. Ver `network-discovery.ts` para a concorrência. */
export const SWEEP_BATCH_SIZE = 64;

export function isIpv4(value: string): boolean {
  return ipToInt(value) !== null;
}

export function ipToInt(value: string): number | null {
  const match = IPV4.exec(value.trim());
  if (!match) return null;
  let total = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    // `Number('01')` é 1, mas '999' passa o regex — o limite é verificado aqui.
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    total = total * 256 + octet;
  }
  return total >>> 0;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

/**
 * Aceita três formas, que é o que as pessoas escrevem:
 *   192.168.1.0/24            — rede e broadcast excluídos (num /31 ou /32 não há o que excluir)
 *   192.168.1.10-40           — último octeto abreviado
 *   192.168.1.10-192.168.1.40 — endereços completos
 *
 * Lança `Error` com mensagem em pt-PT: o texto vai direto para a UI, tanto do
 * lado do renderer como no 400 da rota.
 */
export function expandRange(input: string): string[] {
  const text = input.trim();
  if (!text) throw new Error('Indique um intervalo de endereços');

  const range = text.includes('/') ? fromCidr(text) : fromDashed(text);
  const size = range.end - range.start + 1;

  if (size <= 0) throw new Error('O fim do intervalo vem antes do início');
  if (size > MAX_SWEEP_HOSTS) {
    throw new Error(`Intervalo demasiado grande: ${size} endereços (máximo ${MAX_SWEEP_HOSTS})`);
  }

  const ips: string[] = [];
  for (let n = range.start; n <= range.end; n += 1) ips.push(intToIp(n));
  return ips;
}

function fromCidr(text: string): { start: number; end: number } {
  const [address, bitsText] = text.split('/');
  const base = ipToInt(address ?? '');
  const bits = Number(bitsText);
  if (base === null) throw new Error(`Endereço inválido: ${address}`);
  if (!Number.isInteger(bits) || bits < 8 || bits > 32) {
    throw new Error('Máscara inválida — use entre /8 e /32');
  }

  const size = 2 ** (32 - bits);
  // A máscara é aplicada ao endereço dado: 192.168.1.37/24 é o mesmo /24 que
  // 192.168.1.0/24, que é o que quem escreveu queria dizer.
  const network = bits === 0 ? 0 : (base & (0xffffffff << (32 - bits))) >>> 0;

  // Num /31 (ponto-a-ponto) e num /32 (host único) não há rede nem broadcast
  // para excluir — excluí-los devolveria uma lista vazia.
  if (size <= 2) return { start: network, end: network + size - 1 };
  return { start: network + 1, end: network + size - 2 };
}

function fromDashed(text: string): { start: number; end: number } {
  const [startText, endText] = text.split('-');
  if (endText === undefined) {
    const single = ipToInt(text);
    if (single === null) throw new Error(`Endereço inválido: ${text}`);
    return { start: single, end: single };
  }

  const start = ipToInt(startText ?? '');
  if (start === null) throw new Error(`Endereço inválido: ${startText}`);

  const tail = endText.trim();
  // Forma abreviada (`.1-254`): o fim herda os três primeiros octetos do início.
  // O `>>> 0` não é decorativo — em JS o `&` trabalha em 32 bits com sinal, e
  // qualquer IP acima de 128.x.x.x (todo o 192.168/16) sairia negativo daqui.
  const end = tail.includes('.')
    ? ipToInt(tail)
    : /^\d{1,3}$/.test(tail) && Number(tail) <= 255
      ? ((start & 0xffffff00) >>> 0) + Number(tail)
      : null;

  if (end === null) throw new Error(`Endereço inválido: ${tail}`);
  return { start, end };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('Tamanho de lote inválido');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

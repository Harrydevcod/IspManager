import { inflateSync } from 'node:zlib';

/** Inspect real PDFKit output, including text placement, without mocking layout. */
export function inspectPdfLayout(pdf: Buffer) {
  const raw = pdf.toString('latin1');
  const pages = [...raw.matchAll(/\/MediaBox \[([\d. ]+)\]/g)].map(match => match[1].split(' ').map(Number));
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(match => {
    try { return [inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')]; } catch { return []; }
  });
  const text = streams.map(stream => [...stream.matchAll(/BT([\s\S]*?)ET/g)].flatMap(block => {
    const matrix = block[1].match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
    if (!matrix) return [];
    return [{ x: Number(matrix[1]), y: Number(matrix[2]), value: [...block[1].matchAll(/<([\da-f]+)>/gi)].map(hex => Buffer.from(hex[1], 'hex').toString('latin1')).join('') }];
  }));
  return { pages, text };
}

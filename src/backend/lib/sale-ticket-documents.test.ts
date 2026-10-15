import Database from 'better-sqlite3';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('../db/database', () => ({ getSqliteDatabase: () => state.db }));

import { renderSaleTicketPdf, type SaleTicketFormat } from './sale-ticket-documents';
import { inspectPdfLayout } from './pdf.testing';

const db = new Database(':memory:');
state.db = db;
db.exec(`
  CREATE TABLE payments (id INTEGER PRIMARY KEY, document_type TEXT, invoice_number TEXT,
    invoice_date TEXT, amount_cve REAL, status TEXT, payment_method TEXT, payment_date TEXT, notes TEXT);
  CREATE TABLE payment_lines (id INTEGER PRIMARY KEY, payment_id INTEGER, description TEXT, amount_cve REAL, sort_order INTEGER, item_code TEXT, item_note TEXT, article_id INTEGER);
  CREATE TABLE articles (id INTEGER PRIMARY KEY, kind TEXT);
  CREATE TABLE sale_ticket_lines (payment_line_id INTEGER PRIMARY KEY, catalog_id INTEGER, quantity INTEGER, unit_price_cve REAL);
  CREATE TABLE sale_ticket_serials (id INTEGER PRIMARY KEY, payment_line_id INTEGER, serial_number TEXT, normalized_serial TEXT, released_at TEXT);
  CREATE TABLE payment_receipts (id INTEGER PRIMARY KEY, payment_id INTEGER, account_id INTEGER);
  CREATE TABLE treasury_accounts (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, bank_name TEXT,
    holder_name TEXT, nib TEXT, account_number TEXT, reference TEXT, active INTEGER,
    show_on_documents INTEGER, sort_order INTEGER);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
`);

beforeEach(() => {
  db.exec(`DELETE FROM sale_ticket_serials; DELETE FROM sale_ticket_lines; DELETE FROM payment_lines;
    DELETE FROM payment_receipts; DELETE FROM payments; DELETE FROM treasury_accounts; DELETE FROM app_settings;
    INSERT INTO payments VALUES (1, 'sale_ticket', 'TV-2026-00001', '2026-10-13', 3450, 'paid', 'numerario', '2026-10-13', 'Garantia de 24 meses');
    INSERT INTO payment_lines(id,payment_id,description,amount_cve,sort_order,item_code) VALUES (1, 1, 'Router de acesso', 3450, 0, 'EQP0007');
    INSERT INTO sale_ticket_lines VALUES (1, NULL, 3, 1150);
    INSERT INTO sale_ticket_serials VALUES (1, 1, 'SN-ALPHA-001', 'SNALPHA001', NULL);
    INSERT INTO treasury_accounts VALUES (1, 'Caixa principal', 'caixa', NULL, NULL, NULL, NULL, NULL, 1, 0, 0);
    INSERT INTO payment_receipts VALUES (1, 1, 1);
    INSERT INTO app_settings VALUES ('companyName', 'Nova Tech'), ('nif', '200000001'),
      ('address', 'Praia, Cabo Verde'), ('email', 'loja@example.cv'), ('showIva', 'true'),
      ('ivaRate', '15'), ('printQrCode', 'true');
  `);
});

afterAll(() => db.close());

// PDFKit's built-in Helvetica uses WinAnsi, and writes text as hex strings in
// compressed content streams. Read those streams to verify actual PDF output.
function inspectPdf(buffer: Buffer) {
  const raw = buffer.toString('latin1');
  const streams: string[] = [];
  const pattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of raw.matchAll(pattern)) {
    try { streams.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); } catch { /* non-content stream */ }
  }
  const text = streams.map((stream) => [...stream.matchAll(/<([\da-f]+)>/gi)]
    .map((match) => Buffer.from(match[1], 'hex').toString('latin1')).join('')).join('\n');
  const pages = [...raw.matchAll(/\/MediaBox \[([\d. ]+)\]/g)].map((match) => match[1].split(' ').map(Number));
  return { raw, text, pages, streams };
}

describe('talão de venda PDF', () => {
  test.each(['a4', 'a5', '80mm'] as const)('gera %s com número TV, venda, séries, pagamento e IVA incluído', async (format) => {
    const changes = db.prepare('SELECT total_changes() AS changes').get();
    const result = await renderSaleTicketPdf(1, format);
    const pdf = inspectPdf(result.buffer);
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.filename).toBe(`Talão de venda - TV-2026-00001 - ${format}.pdf`);
    for (const value of ['TV-2026-00001', 'Cliente Indiferenciado', 'Router de acesso', 'SN-ALPHA-001',
      '200000001', 'Caixa principal', 'Garantia de 24 meses', '3.450$00', '3.000$00', '450$00', 'IVA 15%', 'PAGO', 'EQP0007']) {
      expect(pdf.text).toContain(value);
    }
    expect(pdf.text).not.toContain('FT-');
    expect(pdf.text).not.toContain('RC-');
    expect(pdf.raw).not.toContain('/Subtype /Image'); // QR setting cannot fabricate a fiscal TV QR.
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0][2]).toBeCloseTo(format === 'a4' ? 595.28 : format === 'a5' ? 419.53 : 80 * 72 / 25.4, 4);
    if (format !== '80mm') expect(pdf.pages[0][3]).toBe(format === 'a4' ? 841.89 : 595.28);
    if (format === '80mm') expect(pdf.pages[0][3]).toBeLessThan(600);
    expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(changes);
  });

  test.each(['a4', 'a5'] as const)('%s aligns parties and repeats table headers on long sales', async (format) => {
    const add = db.prepare('INSERT INTO payment_lines(id,payment_id,description,amount_cve,sort_order) VALUES (?,1,?,100,?)');
    const detail = db.prepare('INSERT INTO sale_ticket_lines VALUES (?,NULL,1,100)');
    for (let index = 2; index <= 90; index++) { add.run(index, `Artigo ${index}`, index); detail.run(index); }
    const layout = inspectPdfLayout((await renderSaleTicketPdf(1, format)).buffer);
    const issuer = layout.text[0].find(text => text.value === 'EMITENTE')!;
    const client = layout.text[0].find(text => text.value === 'CLIENTE')!;
    expect(client.x).toBeGreaterThan(issuer.x + 100);
    expect(client.y).toBeCloseTo(issuer.y, 2);
    for (const texts of layout.text.filter(texts => texts.some(text => /^Artigo/.test(text.value)))) {
      expect(texts.some(text => text.value === 'DESCRIÇÃO')).toBe(true);
    }
  });

  test('anulado mantém número e séries libertadas e assinala o estado', async () => {
    db.exec("UPDATE payments SET status = 'cancelled'; UPDATE sale_ticket_serials SET released_at = '2026-10-14';");
    const pdf = inspectPdf((await renderSaleTicketPdf(1, '80mm')).buffer);
    expect(pdf.text).toContain('ANULADO');
    expect(pdf.text).toContain('Documento sem efeito');
    expect(pdf.text).toContain('TV-2026-00001');
    expect(pdf.text).toContain('SN-ALPHA-001');
    expect(pdf.text).not.toContain('PAGO');
  });

  test.each(['a4', 'a5', '80mm'] as const)('%s pagina descrições e séries longas sem cortar conteúdo', async (format) => {
    const description = 'Descrição extensa de equipamento para instalação ' + 'ABCDEFGHIJ'.repeat(110) + ' FIM-DESCRICAO';
    db.prepare('UPDATE payment_lines SET description = ?').run(description);
    const insertLine = db.prepare('INSERT INTO payment_lines(id,payment_id,description,amount_cve,sort_order) VALUES (?, 1, ?, 10, ?)');
    const insertSale = db.prepare('INSERT INTO sale_ticket_lines VALUES (?, NULL, 1, 10)');
    for (let index = 2; index <= 90; index += 1) {
      insertLine.run(index, `Item-${index} equipamento vendido`, index);
      insertSale.run(index);
    }
    const serial = 'SERIAL-' + '1234567890'.repeat(45) + '-FIM-SERIAL';
    db.prepare('UPDATE sale_ticket_serials SET serial_number = ?').run(serial);
    const pdf = inspectPdf((await renderSaleTicketPdf(1, format)).buffer);
    expect(pdf.pages.length).toBeGreaterThan(1);
    expect(pdf.text).toContain('FIM-DESCRICAO');
    expect(pdf.text.replace(/\n/g, '')).toContain('FIM-SERIAL');
    expect(pdf.text).toContain('Item-90');
    expect(pdf.text.match(/TALÃO DE VENDA/g)?.length).toBe(pdf.pages.length);
    expect(pdf.text).toContain(`${pdf.pages.length}/${pdf.pages.length}`);
    for (const page of pdf.pages) {
      expect(page[2]).toBeCloseTo(format === 'a4' ? 595.28 : format === 'a5' ? 419.53 : 80 * 72 / 25.4, 4);
      expect(page[3]).toBeLessThanOrEqual(format === 'a4' ? 842 : format === 'a5' ? 596 : 1440);
    }
    // PDFKit flips the text matrix back to PDF coordinates; every baseline
    // must stay inside the page, including repeated headers and footers.
    for (const [pageIndex, stream] of pdf.streams.entries()) {
      const pageHeight = pdf.pages[pageIndex][3];
      for (const match of stream.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)) {
        expect(Number(match[1])).toBeGreaterThanOrEqual(12);
        expect(Number(match[2])).toBeGreaterThan(0);
        expect(Number(match[2])).toBeLessThan(pageHeight);
      }
    }
  });

  test('REMPE imprime a isenção sem criar IVA', async () => {
    db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('fiscalRegime', 'rempe');
    const pdf = inspectPdf((await renderSaleTicketPdf(1, 'a4')).buffer);
    expect(pdf.text).toContain('REMPE - art. 9 da Lei 70/VIII/2014');
    expect(pdf.text).not.toContain('IVA 15%');
  });

  test('80mm adapta a altura da última página ao conteúdo para evitar papel em branco', async () => {
    const add = db.prepare('INSERT INTO payment_lines(id,payment_id,description,amount_cve,sort_order) VALUES (?,1,?,100,?)');
    const detail = db.prepare('INSERT INTO sale_ticket_lines VALUES (?,NULL,1,100)');
    for (let index=2; index<=20; index++) {
      add.run(index, `Artigo ${index}: ` + 'Descrição detalhada do produto fornecido ao comprador. '.repeat(3), index);
      detail.run(index);
    }
    const pdf = inspectPdf((await renderSaleTicketPdf(1, '80mm')).buffer);
    expect(pdf.pages.length).toBeGreaterThan(1);
    expect(pdf.pages.at(-1)![3]).toBeLessThan(pdf.pages[0][3]);
    expect(pdf.text).toContain('Artigo 20');
  });

  test('IVA oculto mantém o total sem inventar isenção', async () => {
    db.exec("UPDATE app_settings SET value = 'false' WHERE key = 'showIva'");
    const pdf = inspectPdf((await renderSaleTicketPdf(1, '80mm')).buffer);
    expect(pdf.text).toContain('3.450$00');
    expect(pdf.text).not.toContain('IVA');
    expect(pdf.text).not.toContain('isenta');
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejeita id inválido %s', async (id) => {
    await expect(renderSaleTicketPdf(id, 'a4')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejeita formato inválido antes de consultar a base', async () => {
    await expect(renderSaleTicketPdf(1, 'a3' as SaleTicketFormat)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('pagamento ausente ou fatura não é talão', async () => {
    await expect(renderSaleTicketPdf(999, 'a4')).rejects.toMatchObject({ statusCode: 404 });
    db.exec("UPDATE payments SET document_type = 'invoice'");
    await expect(renderSaleTicketPdf(1, 'a4')).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each(['pending', 'partial', 'overdue'])('rejeita estado %s', async (status) => {
    db.prepare('UPDATE payments SET status = ?').run(status);
    await expect(renderSaleTicketPdf(1, 'a4')).rejects.toMatchObject({ statusCode: 409 });
  });

  test.each([null, 'PENDING', 'FT-2026-00001'])('não atribui nem substitui número inválido %s', async (number) => {
    db.prepare('UPDATE payments SET invoice_number = ?').run(number);
    const changes = db.prepare('SELECT total_changes() AS changes').get();
    await expect(renderSaleTicketPdf(1, 'a4')).rejects.toMatchObject({ statusCode: 409 });
    expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(changes);
  });
});

test('nota do artigo e política de produtos saem nas observações do talão', async () => {
  db.exec(`INSERT INTO articles VALUES (9, 'product');
    UPDATE payment_lines SET item_note = 'Recondicionado', article_id = 9 WHERE id = 1;
    INSERT INTO app_settings VALUES ('productPolicy', 'Trocas em 7 dias.');`);
  const pdf = inspectPdf((await renderSaleTicketPdf(1, 'a4')).buffer);
  expect(pdf.text).toContain('EQP0007 Router de acesso: Recondicionado');
  expect(pdf.text).toContain('Trocas em 7 dias.');
  db.exec("DELETE FROM articles; DELETE FROM app_settings WHERE key = 'productPolicy';");
});

import { getSqliteDatabase } from '../db/database';
import { formatEscudos } from '../../shared/money';
import { computeTotals, filenamePart, formatDate, formatQuantity, loadCompany, PALETTE, PaymentDocumentError, productNotes } from './documents';

const PDFDocument = require('pdfkit');

export type SaleTicketFormat = 'a4' | 'a5' | '80mm';

type Ticket = {
  id: number;
  documentType: string;
  number: string | null;
  date: string | null;
  amountCve: number;
  status: string;
  paymentMethod: string | null;
  paymentDate: string | null;
  notes: string | null;
};

type TicketLine = {
  id: number;
  itemCode: string | null;
  itemNote: string | null;
  isProduct: number;
  description: string;
  amountCve: number;
  quantity: number;
  unitPriceCve: number;
  serials: string[];
};

type Cell = { text: string; x: number; width: number; align?: 'left' | 'right' };
type Row = { height: number; cells?: Cell[]; size?: number; bold?: boolean; color?: string; rule?: boolean; keepNext?: boolean; tableHeader?: boolean; item?: boolean };

const METHODS: Record<string, string> = {
  numerario: 'Numerário', cash: 'Numerário', transferencia: 'Transferência',
  transfer: 'Transferência', outro: 'Outro', other: 'Outro'
};

/** A read never allocates a number or emits another fiscal document. */
export async function renderSaleTicketPdf(paymentId: number, format: SaleTicketFormat): Promise<{ buffer: Buffer; filename: string }> {
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) throw new PaymentDocumentError(400, 'Talão de venda inválido');
  if (format !== 'a4' && format !== 'a5' && format !== '80mm') throw new PaymentDocumentError(400, 'Formato inválido: use a4, a5 ou 80mm');

  const db = getSqliteDatabase();
  const ticket = db.prepare(`
    SELECT id, document_type AS documentType, invoice_number AS number,
           invoice_date AS date, amount_cve AS amountCve, status,
           payment_method AS paymentMethod, payment_date AS paymentDate, notes
    FROM payments WHERE id = ?
  `).get(paymentId) as Ticket | undefined;
  if (!ticket || ticket.documentType !== 'sale_ticket') throw new PaymentDocumentError(404, 'Talão de venda não encontrado');
  if (ticket.status !== 'paid' && ticket.status !== 'cancelled') throw new PaymentDocumentError(409, 'O talão de venda ainda não foi emitido');
  if (!ticket.number || !/^TV-\d{4}-\d{5,}$/.test(ticket.number) || !ticket.date) {
    throw new PaymentDocumentError(409, 'Talão de venda sem número ou data de emissão');
  }

  const lines = db.prepare(`
    SELECT l.id, l.item_code AS itemCode, l.item_note AS itemNote, l.description, l.amount_cve AS amountCve,
           (a.kind = 'product' OR t.catalog_id IS NOT NULL) AS isProduct,
           t.quantity, t.unit_price_cve AS unitPriceCve
    FROM payment_lines l JOIN sale_ticket_lines t ON t.payment_line_id = l.id
    LEFT JOIN articles a ON a.id = l.article_id
    WHERE l.payment_id = ? ORDER BY l.sort_order, l.id
  `).all(paymentId) as Omit<TicketLine, 'serials'>[];
  // Released serials remain part of the original, cancelled document.
  const serialRows = db.prepare(`
    SELECT s.payment_line_id AS lineId, s.serial_number AS serial
    FROM sale_ticket_serials s JOIN payment_lines l ON l.id = s.payment_line_id
    WHERE l.payment_id = ? ORDER BY l.sort_order, l.id, s.id
  `).all(paymentId) as { lineId: number; serial: string }[];
  const serials = new Map<number, string[]>();
  for (const row of serialRows) serials.set(row.lineId, [...(serials.get(row.lineId) ?? []), row.serial]);
  const accounts = db.prepare(`
    SELECT DISTINCT a.name FROM payment_receipts r
    JOIN treasury_accounts a ON a.id = r.account_id
    WHERE r.payment_id = ? ORDER BY a.name
  `).all(paymentId) as { name: string }[];

  const buffer = await buildPdf(ticket, lines.map((line) => ({ ...line, serials: serials.get(line.id) ?? [] })), accounts.map((a) => a.name), format);
  return { buffer, filename: `Talão de venda - ${filenamePart(ticket.number, String(paymentId))} - ${format}.pdf` };
}

function buildPdf(ticket: Ticket, lines: TicketLine[], accounts: string[], format: SaleTicketFormat): Promise<Buffer> {
  const company = loadCompany();
  const totals = computeTotals(ticket.amountCve, company);
  const thermal = format === '80mm';
  const a5 = format === 'a5';
  const width = thermal ? 80 * 72 / 25.4 : a5 ? 419.53 : 595.28;
  const margin = thermal ? 12 : a5 ? 28 : 48;
  const contentWidth = width - 2 * margin;
  const fontSize = thermal || a5 ? 9 : 10;
  const lineHeight = thermal ? 12 : a5 ? 13 : 15;
  // Cód. · Descrição · Qtd. · Unitário · Valor; em 80 mm o código vai à frente da descrição.
  const codeWidth = contentWidth * 0.13;
  const descX = margin + contentWidth * 0.14;
  const descWidth = contentWidth * 0.35;
  const qtyX = margin + contentWidth * 0.51;
  const unitX = margin + contentWidth * 0.61;
  const amountX = margin + contentWidth * 0.81;
  const rows: Row[] = [];
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, margin: 0, info: {
    Title: `Talão de venda ${ticket.number}`, Author: company.companyName, Subject: 'Talão de venda'
  } });

  // Break oversized words too: serial numbers and pasted descriptions can be
  // unbroken strings. Explicit line placement also makes pagination predictable.
  const wrap = (value: string, availableWidth: number, size: number, bold = false): string[] => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    const result: string[] = [];
    for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
      let current = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const combined = current ? `${current} ${word}` : word;
        if (doc.widthOfString(combined) <= availableWidth) { current = combined; continue; }
        if (current) { result.push(current); current = ''; }
        for (const char of word) {
          if (current && doc.widthOfString(current + char) > availableWidth) { result.push(current); current = ''; }
          current += char;
        }
      }
      result.push(current);
    }
    return result;
  };
  const text = (value: string, opts: { size?: number; bold?: boolean; color?: string; gap?: number } = {}) => {
    const size = opts.size ?? fontSize;
    const height = Math.max(lineHeight, size * 1.3);
    for (const part of wrap(value, contentWidth, size, opts.bold)) {
      rows.push({ height, size, bold: opts.bold, color: opts.color, cells: [{ text: part, x: margin, width: contentWidth }] });
    }
    if (opts.gap) rows.push({ height: opts.gap });
  };
  const rule = (gap = 12) => rows.push({ height: gap, rule: true });
  const label = (value: string) => text(value, { size: thermal ? 7 : 8, bold: true, color: PALETTE.accent, gap: 4 });

  if (thermal) {
    label('EMITENTE');
    text(company.companyName || 'ISPM', { size: 13, bold: true, gap: 3 });
    for (const value of [company.nif && `NIF ${company.nif}`, company.address, company.island, company.phone]) {
      if (value) text(value, { size: 8, color: PALETTE.muted });
    }
    rule();
    label('CLIENTE');
    text('Cliente Indiferenciado', { bold: true, gap: 10 });
  } else {
    const rightWidth = contentWidth * 0.42;
    const rightX = width - margin - rightWidth;
    const leftWidth = contentWidth - rightWidth - 20;
    rows.push({ height: 15, size: 8, bold: true, color: PALETTE.accent, cells: [
      { text: 'EMITENTE', x: margin, width: leftWidth }, { text: 'CLIENTE', x: rightX, width: rightWidth }
    ] });
    const leftNames = wrap(company.companyName || 'ISPM', leftWidth, 11, true);
    const rightNames = wrap('Cliente Indiferenciado', rightWidth, 11, true);
    for (let i = 0; i < Math.max(leftNames.length, rightNames.length); i++) {
      rows.push({ height: 15, size: 11, bold: true, cells: [
        ...(leftNames[i] ? [{ text: leftNames[i], x: margin, width: leftWidth }] : []),
        ...(rightNames[i] ? [{ text: rightNames[i], x: rightX, width: rightWidth }] : [])
      ] });
    }
    for (const value of [company.nif && `NIF ${company.nif}`, company.address, company.island, company.phone]) {
      if (value) for (const part of wrap(value, leftWidth, 9)) rows.push({ height: 12, size: 9, color: PALETTE.muted, cells: [{ text: part, x: margin, width: leftWidth }] });
    }
    rule(16);
  }

  let tableHeader: Row | undefined;
  if (!thermal) {
    tableHeader = { height: 23, size: 8, bold: true, color: PALETTE.muted, cells: [
      { text: 'CÓD.', x: margin, width: codeWidth },
      { text: 'DESCRIÇÃO', x: descX, width: descWidth },
      { text: 'QTD.', x: qtyX, width: contentWidth * 0.08, align: 'right' },
      { text: 'UNITÁRIO', x: unitX, width: contentWidth * 0.18, align: 'right' },
      { text: 'VALOR', x: amountX, width: contentWidth * 0.19, align: 'right' }
    ], rule: true, keepNext: true, tableHeader: true };
    rows.push(tableHeader);
  } else label('ARTIGOS');

  for (const line of lines) {
    const descriptionWidth = thermal ? contentWidth : descWidth;
    const descriptionX = thermal ? margin : descX;
    const label = thermal && line.itemCode ? `${line.itemCode} · ${line.description}` : line.description;
    const descriptionLines = wrap(label, descriptionWidth, fontSize, true);
    descriptionLines.forEach((part, index) => {
      const cells: Cell[] = [{ text: part, x: descriptionX, width: descriptionWidth }];
      if (!thermal && index === 0) cells.push(
        { text: line.itemCode || '-', x: margin, width: codeWidth },
        { text: formatQuantity(line.quantity), x: qtyX, width: contentWidth * 0.08, align: 'right' },
        { text: formatEscudos(line.unitPriceCve), x: unitX, width: contentWidth * 0.18, align: 'right' },
        { text: formatEscudos(line.amountCve), x: amountX, width: contentWidth * 0.19, align: 'right' }
      );
      rows.push({ height: lineHeight, cells, bold: true, size: fontSize, item: true, keepNext: index === descriptionLines.length - 1 && thermal });
    });
    if (thermal) rows.push({ height: 15, size: 8, cells: [
      { text: `${formatQuantity(line.quantity)} x ${formatEscudos(line.unitPriceCve)}`, x: margin, width: contentWidth * 0.57 },
      { text: formatEscudos(line.amountCve), x: margin + contentWidth * 0.59, width: contentWidth * 0.41, align: 'right' }
    ] });
    for (const serial of line.serials) {
      for (const part of wrap(`S/N: ${serial}`, descriptionWidth, thermal ? 7.5 : 8)) {
        rows.push({ height: thermal ? 10 : 12, size: thermal ? 7.5 : 8, color: PALETTE.muted,
          cells: [{ text: part, x: descriptionX, width: descriptionWidth }], item: true });
      }
    }
    rows.push({ height: thermal ? 9 : 14 });
  }
  rule();
  const breakdown = (name: string, amount: number, large = false) => {
    rows.push({ height: large ? (thermal ? 30 : 40) : 17, size: large ? (thermal ? 15 : 24) : fontSize,
      bold: large, color: large ? PALETTE.accent : PALETTE.ink, cells: [
        { text: name, x: margin, width: contentWidth * 0.4 },
        { text: formatEscudos(amount), x: margin + contentWidth * 0.42, width: contentWidth * 0.58, align: 'right' }
      ] });
  };
  if (!totals.isExempt) {
    breakdown('Subtotal', totals.subtotal);
    breakdown(`IVA ${totals.ivaRate}%`, totals.iva);
  } else if (totals.exemptReason) text(totals.exemptReason, { size: thermal ? 7.5 : 9, color: PALETTE.muted, gap: 4 });
  breakdown('TOTAL', totals.total, true);
  text(`Moeda ${company.currencyCode || 'CVE'}`, { size: 8, color: PALETTE.muted, gap: 7 });
  if (ticket.status === 'cancelled') text('ANULADO - Documento sem efeito', { bold: true, color: PALETTE.danger, gap: 7 });
  if (ticket.paymentMethod) text(`Método de pagamento: ${METHODS[ticket.paymentMethod] ?? ticket.paymentMethod}`);
  if (ticket.paymentDate) text(`Pagamento em ${formatDate(ticket.paymentDate)}`);
  for (const account of accounts) text(`Conta: ${account}`, { size: thermal ? 8 : 9, color: PALETTE.muted });
  for (const note of [...productNotes(lines, company), ticket.notes?.trim(), company.legalNotes?.trim()]) {
    if (note) { rule(); text(note, { size: thermal ? 8 : 9, color: PALETTE.muted }); }
  }
  if (thermal && company.email) { rule(); text(company.email, { size: 8, color: PALETTE.muted }); }

  const headingHeight = thermal ? 64 : a5 ? 66 : 87;
  const footerHeight = thermal ? 24 : 38;
  const height = thermal
    ? Math.min(1440, Math.max(280, Math.ceil(headingHeight + rows.reduce((sum, row) => sum + row.height, 0) + 2 * margin + footerHeight)))
    : a5 ? 595.28 : 841.89;
  const pageRows: Row[][] = [[]];
  const available = height - 2 * margin - footerHeight - headingHeight;
  let used = 0;
  rows.forEach((row, index) => {
    const required = row.height + (row.keepNext ? rows[index + 1]?.height ?? 0 : 0);
    if (used + required > available && pageRows[pageRows.length - 1].length) {
      pageRows.push([]); used = 0;
      // A spacer can cause the page break immediately before the next item.
      if ((row.item || (!row.cells && rows[index + 1]?.item)) && tableHeader) {
        pageRows[pageRows.length - 1].push(tableHeader); used += tableHeader.height;
      }
    }
    pageRows[pageRows.length - 1].push(row); used += row.height;
  });
  const pageHeights = pageRows.map((group) => thermal
    ? Math.min(height, Math.max(280, Math.ceil(headingHeight + group.reduce((sum, row) => sum + row.height, 0) + 2 * margin + footerHeight)))
    : height);
  let y = 0;
  let page = 0;
  const write = (cell: Cell, cy: number, size: number, bold: boolean, color: string) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    while (doc.widthOfString(cell.text) > cell.width && size > 5) doc.fontSize(size -= 0.25);
    doc.fillColor(color).text(cell.text, cell.x, cy, { width: cell.width, align: cell.align ?? 'left', lineBreak: false });
  };
  const addPage = (pageHeight: number) => {
    doc.addPage({ size: [width, pageHeight], margin: 0 });
    page += 1;
    write({ text: 'TALÃO DE VENDA', x: margin, width: contentWidth }, margin, thermal ? 9 : 11, true, PALETTE.ink);
    write({ text: ticket.number!, x: margin, width: contentWidth }, margin + (thermal ? 15 : a5 ? 19 : 24), thermal ? 13 : a5 ? 19 : 24, true, PALETTE.accent);
    write({ text: `Emitido em ${formatDate(ticket.date)}  |  ${ticket.status === 'cancelled' ? 'ANULADO' : 'PAGO'}`, x: margin, width: contentWidth },
      margin + (thermal ? 33 : a5 ? 44 : 57), thermal ? 8 : 9, false, ticket.status === 'cancelled' ? PALETTE.danger : PALETTE.muted);
    y = margin + headingHeight;
  };

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      pageRows.forEach((group, index) => {
        addPage(pageHeights[index]);
        for (const row of group) {
          if (row.rule) doc.strokeColor(PALETTE.hairline).lineWidth(0.5).moveTo(margin, y + row.height - 5).lineTo(width - margin, y + row.height - 5).stroke();
          for (const cell of row.cells ?? []) write(cell, y, row.size ?? fontSize, row.bold ?? false, row.color ?? PALETTE.ink);
          y += row.height;
        }
      });
      for (let index = 0; index < page; index += 1) {
        doc.switchToPage(index);
        const bottom = pageHeights[index] - margin - footerHeight;
        const footer = thermal ? `${ticket.number}  |  ${index + 1}/${page}`
          : `${company.companyName || 'ISPM'}${company.email ? ` · ${company.email}` : ''}  |  ${index + 1}/${page}`;
        // The footer is short, and bounded independently from the content flow.
        const parts = wrap(footer, contentWidth, thermal ? 6.5 : 7);
        parts.slice(0, 2).forEach((part, line) => write({ text: part, x: margin, width: contentWidth }, bottom + 12 + line * 9, thermal ? 6.5 : 7, false, PALETTE.muted));
      }
      doc.end();
    } catch (error) { doc.destroy(error instanceof Error ? error : new Error(String(error))); reject(error); }
  });
}

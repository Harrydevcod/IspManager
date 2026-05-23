import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { getSqliteDatabase } from '../db/database';
import { nextDocumentNumber } from '../lib/numbering';
import { requireRole } from './auth';

const PDFDocument = require('pdfkit');

type DocumentKind = 'invoice' | 'receipt';

type PaymentDocumentRow = {
  id: number;
  clientName: string;
  clientCode: string | null;
  clientNif: string | null;
  clientPhone: string | null;
  clientEmail: string | null;
  clientAddress: string | null;
  clientIsland: string | null;
  planName: string | null;
  downloadSpeed: string | null;
  uploadSpeed: string | null;
  referenceMonth: string;
  amountCve: number;
  dueDate: string;
  paymentDate: string | null;
  paymentMethod: string | null;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  invoiceNumber: string | null;
  invoiceDate: string | null;
  receiptNumber: string | null;
  receiptDate: string | null;
  notes: string | null;
};

const documentSelect = `
  SELECT
    py.id,
    c.full_name AS clientName,
    c.client_code AS clientCode,
    c.nif AS clientNif,
    c.phone AS clientPhone,
    c.email AS clientEmail,
    c.address AS clientAddress,
    c.island AS clientIsland,
    p.name AS planName,
    p.download_speed AS downloadSpeed,
    p.upload_speed AS uploadSpeed,
    py.reference_month AS referenceMonth,
    py.amount_cve AS amountCve,
    py.due_date AS dueDate,
    py.payment_date AS paymentDate,
    py.payment_method AS paymentMethod,
    py.status,
    py.invoice_number AS invoiceNumber,
    py.invoice_date AS invoiceDate,
    py.receipt_number AS receiptNumber,
    py.receipt_date AS receiptDate,
    py.notes
  FROM payments py
  JOIN clients c ON c.id = py.client_id
  JOIN services s ON s.id = py.service_id
  LEFT JOIN internet_plans p ON p.id = s.plan_id
  WHERE py.id = ?
`;

type CompanyInfo = {
  companyName: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  island: string;
  currencyCode: string;
  ivaRate: number;
  fiscalRegime: 'normal' | 'rempe';
  showIva: boolean;
  printQrCode: boolean;
  legalNotes: string;
};

const COMPANY_KEYS = [
  'companyName',
  'nif',
  'phone',
  'email',
  'address',
  'island',
  'currencyCode',
  'ivaRate',
  'fiscalRegime',
  'showIva',
  'printQrCode',
  'legalNotes'
] as const;

function loadCompany(): CompanyInfo {
  const db = getSqliteDatabase();
  const placeholders = COMPANY_KEYS.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT key, value FROM app_settings WHERE key IN (${placeholders})`)
    .all(...COMPANY_KEYS) as Array<{ key: string; value: string }>;
  const company: CompanyInfo = {
    companyName: 'ISPM',
    nif: '',
    phone: '',
    email: '',
    address: '',
    island: '',
    currencyCode: 'CVE',
    ivaRate: 15,
    fiscalRegime: 'normal',
    showIva: false,
    printQrCode: false,
    legalNotes: ''
  };
  for (const row of rows) {
    if (row.key === 'ivaRate') {
      const n = Number(row.value);
      company.ivaRate = Number.isFinite(n) ? n : 15;
    } else if (row.key === 'fiscalRegime') {
      company.fiscalRegime = row.value === 'rempe' ? 'rempe' : 'normal';
    } else if (row.key === 'showIva' || row.key === 'printQrCode') {
      company[row.key] = row.value === 'true' || row.value === '1';
    } else if ((COMPANY_KEYS as readonly string[]).includes(row.key)) {
      (company as Record<string, string | number | boolean>)[row.key] = row.value || '';
    }
  }
  return company;
}

function formatCve(value: number, currencyCode = 'CVE') {
  return `${Number(value || 0).toLocaleString('pt-PT')} ${currencyCode}`;
}

function formatDate(value: string | null) {
  if (!value) {
    return '-';
  }
  return value.slice(0, 10);
}

function filenamePart(value: string | number | null | undefined, fallback: string) {
  const cleaned = String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function documentFilename(kind: DocumentKind, row: PaymentDocumentRow) {
  const label = kind === 'invoice' ? 'Fatura' : 'Recibo';
  const number = kind === 'invoice' ? row.invoiceNumber : row.receiptNumber;
  return `${label} - ${filenamePart(row.clientName, 'cliente')} - ${filenamePart(number, String(row.id))}.pdf`;
}

function hasDocumentNumber(value: string | null) {
  return !!value && value !== 'PENDING';
}

function fitText(doc: any, value: string, width: number) {
  const text = String(value || '-').replace(/\s+/g, ' ').trim() || '-';
  if (doc.widthOfString(text) <= width) {
    return text;
  }

  const suffix = '...';
  let fitted = text;
  while (fitted.length > 0 && doc.widthOfString(`${fitted}${suffix}`) > width) {
    fitted = fitted.slice(0, -1);
  }

  return fitted.length > 0 ? `${fitted}${suffix}` : suffix;
}

type PartyLine = { label?: string; value: string; bold?: boolean };

type Totals = {
  subtotal: number;
  iva: number;
  total: number;
  ivaRate: number;
  isExempt: boolean;
  exemptReason: string;
};

const PALETTE = {
  ink: '#1a1714',
  inkSoft: '#2b2620',
  muted: '#6b6258',
  light: '#b8ad9a',
  hairline: '#e1d6c0',
  paperTint: '#faf6ed',
  paperTint2: '#f4eedc',
  accent: '#b07a2a',
  accentSoft: '#cbbda8',
  paper: '#fffaf0',
  success: '#3f7a4b',
  danger: '#c64a3f'
};

function computeTotals(amountCve: number, company: CompanyInfo): Totals {
  const total = Number(amountCve) || 0;
  if (!company.showIva) {
    return { subtotal: total, iva: 0, total, ivaRate: 0, isExempt: true, exemptReason: '' };
  }
  if (company.fiscalRegime === 'rempe') {
    return { subtotal: total, iva: 0, total, ivaRate: 0, isExempt: true, exemptReason: 'REMPE - art. 9 da Lei 70/VIII/2014' };
  }
  const rate = Number(company.ivaRate) || 0;
  if (rate <= 0) {
    return { subtotal: total, iva: 0, total, ivaRate: 0, isExempt: true, exemptReason: 'Operacao isenta de IVA' };
  }
  const subtotal = total / (1 + rate / 100);
  return { subtotal, iva: total - subtotal, total, ivaRate: rate, isExempt: false, exemptReason: '' };
}

function buildQrPayload(row: PaymentDocumentRow, company: CompanyInfo, kind: DocumentKind, totals: Totals): string {
  const code = kind === 'invoice' ? 'FT' : 'RC';
  const rawDate = (kind === 'receipt' ? row.receiptDate || row.paymentDate : row.invoiceDate) || row.dueDate || '';
  const dateClean = rawDate ? rawDate.replace(/-/g, '').slice(0, 8) : '';
  const docNumber = (kind === 'invoice' ? row.invoiceNumber : row.receiptNumber) || 'PEND';
  return [
    `A:${company.nif || 'PEND'}`,
    `B:${row.clientNif || 'CF'}`,
    'C:CV',
    `D:${code}`,
    `E:${kind === 'receipt' ? 'PAGO' : (row.status || 'PEND').toUpperCase()}`,
    `F:${dateClean}`,
    `G:${docNumber}`,
    `H:PEND`,
    `I1:${Math.round(totals.subtotal)}`,
    `I3:${Math.round(totals.iva)}`,
    `N:${Math.round(totals.iva)}`,
    `O:${Math.round(totals.total)}`,
    'Q:PEND',
    'R:PEND'
  ].join('*');
}

function writeParty(
  doc: any,
  x: number,
  y: number,
  width: number,
  label: string,
  lines: PartyLine[],
  align: 'left' | 'right' = 'left'
): number {
  // Eyebrow da secção (EMITENTE / CLIENTE) com hairline acentuado abaixo.
  doc.fillColor(PALETTE.accent).fontSize(7).font('Helvetica-Bold')
    .text(label, x, y, { width, align, lineBreak: false, characterSpacing: 1.6 });
  const hairlineX = align === 'right' ? x + width - 18 : x;
  doc.strokeColor(PALETTE.accent).lineWidth(0.6)
    .moveTo(hairlineX, y + 11.5).lineTo(hairlineX + 18, y + 11.5).stroke();
  let cursor = y + 18;
  for (const line of lines) {
    if (line.bold) {
      doc.fillColor(PALETTE.ink).fontSize(13).font('Helvetica-Bold')
        .text(fitText(doc, line.value, width), x, cursor, { width, align, lineBreak: false });
      cursor += 19;
      continue;
    }
    if (line.label) {
      doc.fillColor(PALETTE.muted).fontSize(6.5).font('Helvetica-Bold')
        .text(line.label.toUpperCase(), x, cursor, { width, align, lineBreak: false, characterSpacing: 1 });
      cursor += 9;
    }
    doc.fillColor(PALETTE.ink).fontSize(9.5).font('Helvetica')
      .text(fitText(doc, line.value, width), x, cursor, { width, align, lineBreak: false });
    cursor += 13;
  }
  return cursor;
}

function buildDocument(
  doc: any,
  row: PaymentDocumentRow,
  company: CompanyInfo,
  kind: DocumentKind,
  totals: Totals,
  qrPng: Buffer | null
) {
  const isReceipt = kind === 'receipt';
  const label = isReceipt ? 'RECIBO' : 'FATURA';
  const docNumber = isReceipt ? row.receiptNumber : row.invoiceNumber;
  const docDate = isReceipt ? row.receiptDate || row.paymentDate : row.invoiceDate;
  const W = doc.page.width;
  const H = doc.page.height;
  const M = 40;
  const CW = W - M * 2;
  const currency = company.currencyCode || 'CVE';

  // === 1) MASTHEAD — duas colunas alinhadas com as Party Columns abaixo
  const colW = (CW - 32) / 2;
  const rightX = M + colW + 32;

  let y = M;
  // LEFT: brand
  doc.fillColor(PALETTE.accent).fontSize(7).font('Helvetica-Bold')
    .text('ISP - CABO VERDE', M, y, { width: colW, lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.ink).fontSize(24).font('Helvetica-Bold')
    .text(fitText(doc, company.companyName || 'ISPM', colW), M, y + 12, { width: colW, lineBreak: false });

  // RIGHT: doc info (FATURA / FT 004/2026-05 / Emitido em ...)
  doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
    .text(label, rightX, y, { width: colW, align: 'right', lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.accent).fontSize(22).font('Helvetica-Bold')
    .text(fitText(doc, docNumber || '—', colW), rightX, y + 12, { width: colW, align: 'right', lineBreak: false });
  doc.fillColor(PALETTE.muted).fontSize(9).font('Helvetica')
    .text(`Emitido em ${formatDate(docDate)}`, rightX, y + 42, { width: colW, align: 'right', lineBreak: false });

  // === 2) PARTY COLUMNS — EMITENTE abaixo do brand, CLIENTE abaixo da info do doc
  const emitenteLines: PartyLine[] = [{ value: company.companyName || 'ISPM', bold: true }];
  if (company.nif) emitenteLines.push({ label: 'NIF', value: company.nif });
  if (company.address) emitenteLines.push({ label: 'Morada', value: company.address });
  if (company.island) emitenteLines.push({ label: 'Ilha', value: company.island });
  if (company.phone) emitenteLines.push({ label: 'Telefone', value: company.phone });
  if (company.email) emitenteLines.push({ label: 'Email', value: company.email });

  // Bloco CLIENTE — apenas identificação (nome, código, NIF) + morada (sede/domicílio,
  // requisito Art. 32 nº5 CIVA). Telefone e Email são confidenciais e omitidos da fatura/recibo.
  const clienteLines: PartyLine[] = [{ value: row.clientName, bold: true }];
  if (row.clientCode) clienteLines.push({ label: 'Código', value: row.clientCode });
  if (row.clientNif) clienteLines.push({ label: 'NIF', value: row.clientNif });
  if (row.clientAddress) clienteLines.push({ label: 'Morada', value: row.clientAddress });
  if (row.clientIsland) clienteLines.push({ label: 'Ilha', value: row.clientIsland });

  const leftPartyY = M + 46;   // 12 (eyebrow gap) + 24 (h1) + 10 (breathing) ≈ 46
  const rightPartyY = M + 62;  // 12 + 22 (number) + 20 (Emitido + breathing) ≈ 62
  const emitenteEnd = writeParty(doc, M, leftPartyY, colW, 'EMITENTE', emitenteLines);
  const clienteEnd = writeParty(doc, rightX, rightPartyY, colW, 'CLIENTE', clienteLines, 'right');
  y = Math.max(emitenteEnd, clienteEnd) + 14;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor(PALETTE.accent).lineWidth(1.2).stroke();
  y += 18;

  // === 3) META STRIP
  const stripH = 46;
  doc.rect(M, y, CW, stripH).fill(PALETTE.paperTint).strokeColor(PALETTE.hairline).lineWidth(0.6).stroke();
  const cellW = CW / 3;
  const writeMeta = (cx: number, key: string, value: string) => {
    doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
      .text(key, cx + 14, y + 10, { width: cellW - 16, lineBreak: false, characterSpacing: 1.2 });
    doc.fillColor(PALETTE.ink).fontSize(11).font('Helvetica-Bold')
      .text(value, cx + 14, y + 24, { width: cellW - 16, lineBreak: false });
  };
  writeMeta(M, 'REFERENCIA', row.referenceMonth || '-');
  doc.moveTo(M + cellW, y + 8).lineTo(M + cellW, y + stripH - 8).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
  writeMeta(M + cellW, 'EMITIDO EM', formatDate(docDate));
  doc.moveTo(M + cellW * 2, y + 8).lineTo(M + cellW * 2, y + stripH - 8).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
  writeMeta(M + cellW * 2, isReceipt ? 'PAGAMENTO' : 'VENCIMENTO', formatDate(isReceipt ? row.paymentDate : row.dueDate));

  y += stripH + 26;

  // === 4) ITEMS TABLE
  const ivaColW = totals.isExempt ? 0 : 80;
  const valueColW = 110;
  const descColW = CW - valueColW - ivaColW - (totals.isExempt ? 0 : 8);

  doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
    .text('DESCRICAO', M, y, { width: descColW, lineBreak: false, characterSpacing: 1.2 });
  if (!totals.isExempt) {
    doc.text('IVA', M + descColW + 4, y, { width: ivaColW, align: 'right', lineBreak: false, characterSpacing: 1.2 });
  }
  doc.text('VALOR', W - M - valueColW, y, { width: valueColW, align: 'right', lineBreak: false, characterSpacing: 1.2 });
  y += 12;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
  y += 16;

  doc.fillColor(PALETTE.ink).fontSize(12).font('Helvetica-Bold')
    .text('Servico de Internet', M, y, { width: descColW, lineBreak: false });
  if (!totals.isExempt) {
    doc.fillColor(PALETTE.ink).fontSize(10).font('Helvetica')
      .text(`${totals.ivaRate}%`, M + descColW + 4, y + 2, { width: ivaColW, align: 'right', lineBreak: false });
  }
  doc.fillColor(PALETTE.ink).fontSize(12).font('Helvetica-Bold')
    .text(formatCve(totals.total, currency), W - M - valueColW, y, { width: valueColW, align: 'right', lineBreak: false });
  y += 16;
  const planLine = `Plano: ${row.planName || '-'} - ${row.downloadSpeed || '-'} / ${row.uploadSpeed || '-'}`;
  doc.fillColor(PALETTE.muted).fontSize(8.5).font('Helvetica')
    .text(fitText(doc, planLine, descColW), M, y, { width: descColW, lineBreak: false });
  y += 12;
  doc.fillColor(PALETTE.light).fontSize(8.5).font('Helvetica')
    .text(`Periodo de referencia ${row.referenceMonth || '-'}`, M, y, { width: descColW, lineBreak: false });
  y += 22;

  // === 5) FISCAL BREAKDOWN — Subtotal · IVA · Total (right-aligned mini table)
  const breakdownW = 240;
  const breakdownX = W - M - breakdownW;
  const writeBreakdownRow = (cy: number, label: string, value: string, opts?: { bold?: boolean; muted?: boolean }) => {
    doc.fillColor(opts?.muted ? PALETTE.muted : PALETTE.ink).fontSize(opts?.bold ? 9 : 9).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, breakdownX, cy, { width: breakdownW / 2, lineBreak: false });
    doc.fillColor(opts?.muted ? PALETTE.muted : PALETTE.ink).fontSize(opts?.bold ? 11 : 10).font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(value, breakdownX + breakdownW / 2, cy - (opts?.bold ? 1 : 0), { width: breakdownW / 2, align: 'right', lineBreak: false });
  };

  if (!totals.isExempt) {
    writeBreakdownRow(y, 'Subtotal', formatCve(totals.subtotal, currency), { muted: true });
    y += 14;
    writeBreakdownRow(y, `IVA ${totals.ivaRate}%`, formatCve(totals.iva, currency), { muted: true });
    y += 18;
    doc.moveTo(breakdownX, y).lineTo(breakdownX + breakdownW, y).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
    y += 8;
  } else if (totals.exemptReason) {
    doc.fillColor(PALETTE.muted).fontSize(7.5).font('Helvetica-Bold')
      .text(totals.exemptReason, breakdownX, y, { width: breakdownW, align: 'right', lineBreak: false, characterSpacing: 0.8 });
    y += 18;
    doc.moveTo(breakdownX, y).lineTo(breakdownX + breakdownW, y).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
    y += 8;
  }

  // === 6) TOTAL BLOCK — ink-saving outlined band (no dark fill), accent rule on top
  const totalH = 56;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor(PALETTE.accent).lineWidth(1.6).stroke();
  doc.moveTo(M, y + totalH).lineTo(W - M, y + totalH).strokeColor(PALETTE.hairline).lineWidth(0.6).stroke();

  doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
    .text('TOTAL', M + 2, y + 14, { width: 120, lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.light).fontSize(7.5).font('Helvetica')
    .text(`Moeda ${currency}`, M + 2, y + 30, { width: 120, lineBreak: false });

  const statusLabel = isReceipt ? 'PAGO' : (row.status || '-').toUpperCase();
  const statusColor = isReceipt
    ? PALETTE.success
    : row.status === 'overdue'
      ? PALETTE.danger
      : PALETTE.accent;
  doc.fillColor(statusColor).fontSize(7).font('Helvetica-Bold')
    .text(statusLabel, W - M - 200 - 2, y + 14, { width: 200, align: 'right', lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.accent).fontSize(22).font('Helvetica-Bold')
    .text(formatCve(totals.total, currency), W - M - 200 - 2, y + 26, { width: 200, align: 'right', lineBreak: false });

  y += totalH + 22;

  // === 7) OBSERVATIONS
  const observations: string[] = [];
  if (isReceipt && row.paymentMethod) {
    observations.push(`Metodo de pagamento: ${row.paymentMethod}`);
  }
  if (row.notes && row.notes.trim()) {
    observations.push(row.notes.trim());
  }
  if (company.legalNotes && company.legalNotes.trim()) {
    observations.push(company.legalNotes.trim());
  }
  if (observations.length > 0) {
    doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
      .text('OBSERVACOES', M, y, { width: CW, lineBreak: false, characterSpacing: 1.2 });
    y += 10;
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
    y += 10;
    for (const note of observations) {
      doc.fillColor(PALETTE.ink).fontSize(9).font('Helvetica')
        .text(note, M, y, { width: CW - 140, lineBreak: true });
      y = doc.y + 6;
    }
    y += 8;
  }

  // === 8) QR CODE BLOCK (optional, preparatorio e-Fatura) — skipped when disabled
  if (qrPng) {
    const qrSize = 84;
    const qrX = M;
    const qrY = H - M - qrSize - 26;
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
      .text('QR FISCAL', qrX + qrSize + 14, qrY + 2, { width: 200, lineBreak: false, characterSpacing: 1.2 });
    doc.fillColor(PALETTE.ink).fontSize(8.5).font('Helvetica')
      .text(
        'Codigo QR preparatorio para e-Fatura CV (Portaria 47/2021).',
        qrX + qrSize + 14,
        qrY + 14,
        { width: CW - qrSize - 14, lineBreak: true }
      );
    doc.fillColor(PALETTE.light).fontSize(7.5).font('Helvetica')
      .text(
        'Os campos H (ATCUD), Q (hash) e R (certificado) aguardam credenciacao na DNRE.',
        qrX + qrSize + 14,
        doc.y + 4,
        { width: CW - qrSize - 14, lineBreak: true }
      );
  }

  // === 9) FOOTER
  const footerY = H - M - 14;
  doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
  const contactParts: string[] = [];
  if (company.nif) contactParts.push(`NIF ${company.nif}`);
  if (company.phone) contactParts.push(company.phone);
  if (company.email) contactParts.push(company.email);
  doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
    .text(
      fitText(doc, `${company.companyName || 'ISPM'}${contactParts.length ? ' · ' + contactParts.join(' · ') : ''}`, CW),
      M,
      footerY + 2,
      { width: CW, align: 'center', lineBreak: false }
    );
}

async function pdfBuffer(row: PaymentDocumentRow, kind: DocumentKind) {
  const company = loadCompany();
  const totals = computeTotals(row.amountCve, company);
  const qrPng: Buffer | null = company.printQrCode
    ? await QRCode.toBuffer(buildQrPayload(row, company, kind, totals), {
        type: 'png',
        margin: 0,
        width: 320,
        errorCorrectionLevel: 'M',
        color: { dark: '#1a1714', light: '#fffaf0' }
      })
    : null;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true,
      autoFirstPage: false
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: 'A4', margin: 40 });
    doc.addPage = () => doc;
    buildDocument(doc, row, company, kind, totals, qrPng);
    doc.end();
  });
}

async function sendDocument(reply: any, row: PaymentDocumentRow, kind: DocumentKind, disposition: 'inline' | 'attachment' = 'attachment') {
  const buffer = await pdfBuffer(row, kind);
  const filename = documentFilename(kind, row);
  reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `${disposition}; filename="${filenamePart(filename, 'documento.pdf')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .send(buffer);
}

function dispositionFromQuery(query: unknown): 'inline' | 'attachment' {
  if (query && typeof query === 'object' && 'inline' in (query as Record<string, unknown>)) {
    const value = (query as Record<string, unknown>).inline;
    if (value === '1' || value === 'true' || value === true) return 'inline';
  }
  return 'attachment';
}

export async function registerDocumentRoutes(app: FastifyInstance) {
  const canIssueDocuments = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/payments/:id/invoice.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    let row = db.prepare(documentSelect).get(id) as PaymentDocumentRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (row.status === 'cancelled') {
      return reply.status(400).send({ error: 'Pagamento anulado nao pode gerar fatura' });
    }

    if (!hasDocumentNumber(row.invoiceNumber)) {
      db.prepare(`
        UPDATE payments
        SET invoice_number = ?, invoice_date = COALESCE(invoice_date, date('now')), updated_at = datetime('now')
        WHERE id = ?
      `).run(nextDocumentNumber('invoice', id), id);
      row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
    }

    return sendDocument(reply, row, 'invoice', dispositionFromQuery(request.query));
  });

  app.get('/api/payments/:id/receipt.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ error: 'Pagamento invalido' });
    }

    const db = getSqliteDatabase();
    let row = db.prepare(documentSelect).get(id) as PaymentDocumentRow | undefined;
    if (!row) {
      return reply.status(404).send({ error: 'Pagamento nao encontrado' });
    }
    if (row.status === 'cancelled') {
      return reply.status(400).send({ error: 'Pagamento anulado nao pode gerar recibo' });
    }
    if (row.status !== 'paid') {
      return reply.status(400).send({ error: 'So e possivel gerar recibo depois do pagamento' });
    }

    if (!row.receiptNumber) {
      db.prepare(`
        UPDATE payments
        SET receipt_number = ?, receipt_date = COALESCE(receipt_date, date('now')), updated_at = datetime('now')
        WHERE id = ?
      `).run(nextDocumentNumber('receipt', id), id);
      row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
    }

    return sendDocument(reply, row, 'receipt', dispositionFromQuery(request.query));
  });
}

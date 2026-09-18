import QRCode from 'qrcode';
import { getSqliteDatabase } from '../db/database';
import { allocateDocumentNumber } from './numbering';
import { formatEscudos } from '../../shared/money';
import { isAudiovisualAnnualReference } from './audiovisual';
import { documentBankAccounts } from './treasury';
import { RENTAL_LINE_PREFIX, type BillingLine } from './billing';

const PDFDocument = require('pdfkit');

const DOCUMENT_MONTH_NAMES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro'
];

export type DocumentKind = 'invoice' | 'receipt';

type DocumentLine = {
  kind: BillingLine['kind'];
  description: string;
  amountCve: number;
};

/**
 * Linha de apoio por baixo de uma rubrica. Em texto simples alinha com a
 * rubrica; em objeto desenha-se indentada (`indent` níveis de 10pt) e, se
 * trouxer `amountCve`, com o valor na coluna da direita.
 */
type Subline = string | { text: string; amountCve?: number; indent?: number } | null;

type FoldedLines = {
  items: DocumentLine[];
  /** Houve aluguer e coube dentro da mensalidade (há linha de internet). */
  hasRental: boolean;
  /** As linhas de aluguer originais, para quem quiser detalhá-las. */
  rentals: DocumentLine[];
};

/** Nota discreta na linha do serviço quando o aluguer foi lá dentro. */
export const RENTAL_INCLUDED_NOTE = 'Inclui equipamento cedido';
/** Descrição da linha própria quando não há mensalidade onde esconder a renda. */
export const RENTAL_ONLY_DESCRIPTION = 'Equipamento cedido';

/**
 * O aluguer não é rubrica própria na fatura: soma-se à mensalidade e deixa só
 * uma nota em letra miúda. Opção comercial — o equipamento "vem incluído" no
 * serviço, como nas operadoras, em vez de ser uma renda destacada todos os
 * meses. A BD (`payment_lines`) mantém as linhas separadas com o modelo do
 * equipamento; isto é apresentação, e o total nunca muda.
 *
 * Serviço suspenso paga só a renda (ver `buildMonthlyServiceLines` em
 * ./billing) — sem linha de internet onde somar, as rendas colapsam numa única
 * linha apagada em vez de a fatura descrever internet que está cortada.
 */
export function foldRentalLines(lines: DocumentLine[]): FoldedLines {
  const rentals = lines.filter((line) => line.kind === 'aluguer');
  if (rentals.length === 0) return { items: lines, hasRental: false, rentals };
  const rentalTotal = rentals.reduce((sum, line) => sum + Number(line.amountCve || 0), 0);

  const others = lines.filter((line) => line.kind !== 'aluguer');
  const host = others.find((line) => line.kind === 'internet');
  if (host) {
    return {
      items: others.map((line) =>
        line === host ? { ...line, amountCve: line.amountCve + rentalTotal } : line
      ),
      hasRental: true,
      rentals
    };
  }
  return {
    items: [...others, { kind: 'aluguer', description: RENTAL_ONLY_DESCRIPTION, amountCve: rentalTotal }],
    hasRental: false,
    rentals
  };
}

/** Cabeçalho do bloco de equipamento quando `printRentalLines` está ligada. */
export const RENTAL_DETAIL_HEADING = 'Aluguer de equipamento';

/**
 * Nome do equipamento a imprimir a partir da descrição gravada em
 * `payment_lines` (`Aluguer — TP-Link CPE510`): o prefixo já está dito no
 * cabeçalho do bloco, repeti-lo em cada linha só rouba coluna. Descrição fora
 * do padrão (documento antigo, linha escrita à mão) passa inteira — vale mais
 * texto a mais do que uma linha vazia na fatura.
 */
export function rentalDeviceName(description: string): string {
  const name = description.startsWith(RENTAL_LINE_PREFIX)
    ? description.slice(RENTAL_LINE_PREFIX.length).trim()
    : description.trim();
  return name || description;
}

/** Ligações que não contam para a sigla. */
const ACRONYM_STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'para']);

/**
 * Sigla de uma rubrica comprida: `Distribuição de Conteúdos Audiovisuais` → `DCA`.
 * Deriva-se do nome guardado na linha (não de uma constante) para que mudar a
 * denominação nas Definições mude a sigla, e para que um documento antigo
 * mantenha a sua própria. Nome curto de mais fica inteiro — uma sigla de uma
 * letra não diz nada a ninguém.
 */
export function serviceAcronym(description: string): string {
  const words = description
    .split(/[\s—–-]+/)
    .filter((word) => word.length > 0)
    .filter((word) => !ACRONYM_STOPWORDS.has(word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()));
  if (words.length < 2) return description;
  return words.map((word) => word[0].toUpperCase()).join('');
}

/**
 * Rótulo da competência: mês por extenso (`Julho/2026`) para faturas mensais;
 * "Anuidade AAAA" para a anuidade audiovisual.
 */
export function formatReferenceForDocument(reference: string): string {
  if (isAudiovisualAnnualReference(reference)) {
    return `Anuidade ${reference.slice(3, 7)}`;
  }
  const [year, month] = reference.slice(0, 7).split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) return '-';
  return `${DOCUMENT_MONTH_NAMES[month - 1]}/${year}`;
}

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
  bankAccounts: BankAccountInfo[];
  currencyCode: string;
  ivaRate: number;
  fiscalRegime: 'normal' | 'rempe';
  showIva: boolean;
  printQrCode: boolean;
  printRentalLines: boolean;
  legalNotes: string;
};

type BankAccountInfo = {
  bankName: string;
  accountName: string;
  accountNumber: string;
  reference: string;
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
  'printRentalLines',
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
    bankAccounts: [],
    currencyCode: 'CVE',
    ivaRate: 15,
    fiscalRegime: 'normal',
    showIva: false,
    printQrCode: false,
    printRentalLines: false,
    legalNotes: ''
  };
  for (const row of rows) {
    if (row.key === 'ivaRate') {
      const n = Number(row.value);
      company.ivaRate = Number.isFinite(n) ? n : 15;
    } else if (row.key === 'fiscalRegime') {
      company.fiscalRegime = row.value === 'rempe' ? 'rempe' : 'normal';
    } else if (row.key === 'showIva' || row.key === 'printQrCode' || row.key === 'printRentalLines') {
      company[row.key] = row.value === 'true' || row.value === '1';
    } else if ((COMPANY_KEYS as readonly string[]).includes(row.key)) {
      (company as Record<string, string | number | boolean | BankAccountInfo[]>)[row.key] = row.value || '';
    }
  }
  // Desde a 0058 as contas bancárias vivem na Tesouraria; saem na fatura as
  // marcadas com show_on_documents.
  company.bankAccounts = documentBankAccounts(db);
  return company;
}

export function formatBankAccountsForDocument(accounts: BankAccountInfo[]): string | null {
  const lines = accounts
    .filter((account) => account.bankName || account.accountNumber)
    .map((account) => `${account.bankName || 'Banco'}: ${account.accountNumber || '-'}`);
  return lines.length > 0 ? ['Bancos:', ...lines].join('\n') : null;
}

// Money on documents uses the Cape Verde cifrão convention (3.500$00). The
// company `currencyCode` is still surfaced as a "Moeda" label, but amounts are
// always rendered in escudos — this is a CV-only system.
function formatCve(value: number) {
  return formatEscudos(value);
}

// O estado vive na base em ingles; o documento vai para o cliente e le-se em
// portugues. O QR (campo E) fica com o codigo cru — e' dado tecnico.
export function documentStatusLabel(status: string | null | undefined) {
  return STATUS_LABELS[status ?? ''] ?? '-';
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'PENDENTE',
  partial: 'PARCIAL',
  overdue: 'EM ATRASO',
  paid: 'PAGO',
  cancelled: 'ANULADA'
};

export function formatDate(value: string | null) {
  if (!value) {
    return '-';
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(date).replace(/\//g, '-');
}

export function filenamePart(value: string | number | null | undefined, fallback: string) {
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
  const parts = [
    label,
    filenamePart(row.clientName, 'cliente'),
    filenamePart(number, String(row.id))
  ].filter(Boolean);
  return `${parts.join(' - ')}.pdf`;
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
  qrPng: Buffer | null,
  lines: DocumentLine[]
) {
  const isReceipt = kind === 'receipt';
  const label = isReceipt ? 'RECIBO' : 'FATURA';
  const docNumber = isReceipt ? row.receiptNumber : row.invoiceNumber;
  const docDate = isReceipt ? row.receiptDate || row.paymentDate : row.invoiceDate;
  const W = doc.page.width;
  const H = doc.page.height;
  const M = 28; // A5 padrão — margens proporcionais ao formato
  const CW = W - M * 2;
  const currency = company.currencyCode || 'CVE';

  // === 1) MASTHEAD — coluna esquerda (brand + EMITENTE), coluna direita
  // encostada à margem direita (doc info + CLIENTE).
  const rightColW = 140;
  const rightColX = W - M - rightColW; // flush right margin
  const leftColW = CW - rightColW - 20;

  let y = M;
  // LEFT: brand tag (o nome da empresa não vai aqui — figura no rodapé).
  doc.fillColor(PALETTE.accent).fontSize(6.5).font('Helvetica-Bold')
    .text('ISP - CABO VERDE', M, y, { width: leftColW, lineBreak: false, characterSpacing: 1.6 });

  // RIGHT: doc info (FATURA / FT 004/2026-05 / Emitido em ...)
  doc.fillColor(PALETTE.muted).fontSize(6.5).font('Helvetica-Bold')
    .text(label, rightColX, y, { width: rightColW, lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.accent).fontSize(12).font('Helvetica-Bold')
    .text(fitText(doc, docNumber || '—', rightColW), rightColX, y + 11, { width: rightColW, lineBreak: false });
  doc.fillColor(PALETTE.muted).fontSize(8).font('Helvetica')
    .text(`Emitido em ${formatDate(docDate)}`, rightColX, y + 28, { width: rightColW, lineBreak: false });

  // === 2) PARTY COLUMNS — EMITENTE abaixo do brand, CLIENTE abaixo da info do doc
  // Nome da empresa como primeira linha (negrito) do bloco EMITENTE.
  // Sem legendas (morada/ilha/telefone) — o valor fala por si. Mantemos só o
  // prefixo "NIF" inline para não confundir o contribuinte com o telefone.
  const emitenteLines: PartyLine[] = [{ value: company.companyName || 'ISPM', bold: true }];
  if (company.nif) emitenteLines.push({ value: `NIF ${company.nif}` });
  if (company.address) emitenteLines.push({ value: company.address });
  if (company.island) emitenteLines.push({ value: company.island });
  if (company.phone) emitenteLines.push({ value: company.phone });
  // Email do emitente vive só no rodapé (não duplicar aqui).

  // Bloco CLIENTE — apenas identificação (nome, código, NIF) + morada (sede/domicílio,
  // requisito Art. 32 nº5 CIVA). Telefone e Email são confidenciais e omitidos da fatura/recibo.
  // Sem legendas — só os valores. Identificadores (NIF, código) ficam com
  // prefixo inline para não serem ambíguos; morada e ilha falam por si.
  const clienteLines: PartyLine[] = [{ value: row.clientName, bold: true }];
  if (row.clientCode) clienteLines.push({ value: `Cód. ${row.clientCode}` });
  if (row.clientNif) clienteLines.push({ value: `NIF ${row.clientNif}` });
  if (row.clientAddress) clienteLines.push({ value: row.clientAddress });
  if (row.clientIsland) clienteLines.push({ value: row.clientIsland });

  // EMITENTE e CLIENTE arrancam no mesmo Y (paralelos), abaixo da info do
  // documento na coluna direita: 11 (gap) + 12 (nº) + ~5 + 8 (Emitido) + breathing ≈ 44.
  const partyY = M + 44;
  const emitenteEnd = writeParty(doc, M, partyY, leftColW, 'EMITENTE', emitenteLines);
  const clienteEnd = writeParty(doc, rightColX, partyY, rightColW, 'CLIENTE', clienteLines);
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
  writeMeta(M, 'REFERENCIA', formatReferenceForDocument(row.referenceMonth));
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

  const planLine = `Plano: ${row.planName || '-'} - ${row.downloadSpeed || '-'} / ${row.uploadSpeed || '-'}`;
  const audiovisualSubline = isAudiovisualAnnualReference(row.referenceMonth) ? 'Subscricao anual' : 'Subscricao mensal';

  // Uma linha por item do documento. O valor de cada linha é o seu montante
  // (IVA incluído); a soma é o total (amount_cve). O detalhe Subtotal/IVA continua
  // a ser calculado sobre o total na secção 5.
  // `quiet` desenha a rubrica em tom menor — usado na linha de equipamento
  // cedido, que não tem de competir com a mensalidade.
  const renderItem = (
    description: string,
    amount: number,
    sublines: Array<Subline>,
    quiet = false
  ) => {
    const titleSize = quiet ? 10 : 12;
    const titleFont = quiet ? 'Helvetica' : 'Helvetica-Bold';
    const titleColor = quiet ? PALETTE.muted : PALETTE.ink;
    doc.fillColor(titleColor).fontSize(titleSize).font(titleFont)
      .text(fitText(doc, description, descColW), M, y, { width: descColW, lineBreak: false });
    if (!totals.isExempt) {
      doc.fillColor(titleColor).fontSize(10).font('Helvetica')
        .text(`${totals.ivaRate}%`, M + descColW + 4, y + 2, { width: ivaColW, align: 'right', lineBreak: false });
    }
    doc.fillColor(titleColor).fontSize(titleSize).font(titleFont)
      .text(formatCve(amount), W - M - valueColW, y, { width: valueColW, align: 'right', lineBreak: false });
    y += quiet ? 14 : 16;
    for (const subline of sublines) {
      if (!subline) continue;
      // A nota do equipamento é a mais apagada da paleta de propósito: está lá
      // para quem a procurar, não para dar nas vistas. O detalhe do aluguer
      // (definição `printRentalLines`) usa o mesmo tom, indentado para se ler
      // como detalhe da rubrica de cima e não como rubrica nova.
      const detail = typeof subline === 'object';
      const text = detail ? subline.text : subline;
      const note = detail || text === RENTAL_INCLUDED_NOTE;
      const x = detail ? M + 10 * (subline.indent ?? 1) : M;
      const width = descColW - (x - M);
      doc.fillColor(note ? PALETTE.light : PALETTE.muted).fontSize(note ? 7.5 : 8.5).font('Helvetica')
        .text(fitText(doc, text, width), x, y, { width, lineBreak: false });
      if (detail && subline.amountCve !== undefined) {
        doc.fillColor(PALETTE.light).fontSize(7.5).font('Helvetica')
          .text(formatCve(subline.amountCve), W - M - valueColW, y, { width: valueColW, align: 'right', lineBreak: false });
      }
      y += note ? 10 : 12;
    }
  };

  // Documentos com linhas (payment_lines) renderizam o que foi efetivamente
  // faturado. Documentos antigos não têm linhas → fallback à linha única de
  // internet histórica (nunca se reescreve um documento já emitido).
  if (lines.length > 0) {
    const { items, hasRental, rentals } = foldRentalLines(lines);
    // Um equipamento por linha, com a sua renda. O prefixo "Aluguer —" fica no
    // cabeçalho do bloco em vez de se repetir em cada nome.
    const rentalDetail = (indent: number): Subline[] =>
      rentals.map((rental) => ({
        text: rentalDeviceName(rental.description),
        amountCve: rental.amountCve,
        indent
      }));
    // "Suplementar" é relativo: o audiovisual só encolhe quando acompanha outra
    // rubrica. Na fatura da anuidade é ele a única, e fica em tamanho normal.
    const supplementary = items.length > 1;
    for (const line of items) {
      const sublines: Array<Subline> = [];
      if (line.kind === 'internet') {
        sublines.push(planLine);
        // O total da rubrica é o mesmo nos dois modos; só muda se o cliente vê
        // que equipamento paga e quanto.
        if (hasRental) {
          if (company.printRentalLines) {
            sublines.push({ text: RENTAL_DETAIL_HEADING }, ...rentalDetail(2));
          } else {
            sublines.push(RENTAL_INCLUDED_NOTE);
          }
        }
      }
      // Serviço suspenso: a rubrica "Equipamento cedido" já diz o que é, só lhe
      // falta dizer qual — sem cabeçalho a repetir o título de cima.
      if (line.kind === 'aluguer' && company.printRentalLines) {
        sublines.push(...rentalDetail(1));
      }
      // O audiovisual imprime-se pela sigla, com o nome por extenso em baixo: o
      // nome legal é comprido e comeria a coluna toda.
      let title = line.description;
      if (line.kind === 'audiovisual') {
        title = serviceAcronym(line.description);
        if (title !== line.description) sublines.push(line.description);
        sublines.push(audiovisualSubline);
      }
      renderItem(title, line.amountCve, sublines, line.kind === 'aluguer' || (line.kind === 'audiovisual' && supplementary));
    }
  } else {
    renderItem('Servico de Internet', totals.total, [planLine]);
  }
  doc.fillColor(PALETTE.light).fontSize(8.5).font('Helvetica')
    .text(`Periodo de referencia ${formatReferenceForDocument(row.referenceMonth)}`, M, y, { width: descColW, lineBreak: false });
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
    writeBreakdownRow(y, 'Subtotal', formatCve(totals.subtotal), { muted: true });
    y += 14;
    writeBreakdownRow(y, `IVA ${totals.ivaRate}%`, formatCve(totals.iva), { muted: true });
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

  const statusLabel = isReceipt ? 'PAGO' : documentStatusLabel(row.status);
  const statusColor = isReceipt
    ? PALETTE.success
    : row.status === 'overdue'
      ? PALETTE.danger
      : PALETTE.accent;
  doc.fillColor(statusColor).fontSize(7).font('Helvetica-Bold')
    .text(statusLabel, W - M - 200 - 2, y + 14, { width: 200, align: 'right', lineBreak: false, characterSpacing: 1.6 });
  doc.fillColor(PALETTE.accent).fontSize(22).font('Helvetica-Bold')
    .text(formatCve(totals.total), W - M - 200 - 2, y + 26, { width: 200, align: 'right', lineBreak: false });

  y += totalH + 22;

  // === 7) OBSERVATIONS
  const observations: string[] = [];
  if (!isReceipt) {
    // Aviso fiscal de suspensão — presente apenas em faturas (não em recibos).
    observations.push(
      'Após a data limite de pagamento indicada, o serviço poderá ser suspenso por falta de regularização.'
    );
    const bankAccountsNote = formatBankAccountsForDocument(company.bankAccounts);
    if (bankAccountsNote) {
      observations.push(bankAccountsNote);
    }
  }
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

  // === 9) FOOTER — apenas nome da empresa + email.
  const footerY = H - M - 14;
  doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
  const footerText = company.email
    ? `${company.companyName || 'ISPM'} · ${company.email}`
    : (company.companyName || 'ISPM');
  doc.fillColor(PALETTE.muted).fontSize(7).font('Helvetica-Bold')
    .text(
      fitText(doc, footerText, CW),
      M,
      footerY + 2,
      { width: CW, align: 'center', lineBreak: false }
    );
}

async function pdfBuffer(row: PaymentDocumentRow, kind: DocumentKind, lines: DocumentLine[]) {
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
      size: 'A5',
      margin: 28,
      bufferPages: true,
      autoFirstPage: false
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: 'A5', margin: 28 });
    doc.addPage = () => doc;
    buildDocument(doc, row, company, kind, totals, qrPng, lines);
    doc.end();
  });
}

/**
 * PDF de UM recebimento.
 *
 * O documento e do recibo, nao da fatura: o total impresso e o que entrou
 * naquele momento, e o rodape diz o que ainda falta. Imprimir o valor cheio da
 * fatura num recibo de 10.000 seria dar ao cliente prova de ter pago 50.000.
 *
 * Reaproveita o desenho da fatura sobrepondo os valores do recibo na linha —
 * o layout, o QR e os totais ja sabem trabalhar com um `PaymentDocumentRow`.
 */
export async function renderReceiptPdf(receiptId: number): Promise<{ buffer: Buffer; filename: string }> {
  if (!Number.isInteger(receiptId) || receiptId <= 0) {
    throw new PaymentDocumentError(400, 'Recibo invalido');
  }
  const db = getSqliteDatabase();
  const receipt = db.prepare(`
    SELECT id, payment_id AS paymentId, amount_cve AS amountCve, payment_date AS paymentDate,
           payment_method AS paymentMethod, source, receipt_number AS receiptNumber,
           receipt_date AS receiptDate, voided_at AS voidedAt
    FROM payment_receipts WHERE id = ?
  `).get(receiptId) as {
    id: number; paymentId: number; amountCve: number; paymentDate: string;
    paymentMethod: string; source: string; receiptNumber: string;
    receiptDate: string; voidedAt: string | null;
  } | undefined;

  if (!receipt) {
    throw new PaymentDocumentError(404, 'Recibo nao encontrado');
  }
  if (receipt.voidedAt) {
    throw new PaymentDocumentError(400, 'Recibo anulado nao pode ser impresso');
  }

  const invoice = db.prepare(documentSelect).get(receipt.paymentId) as PaymentDocumentRow | undefined;
  if (!invoice) {
    throw new PaymentDocumentError(404, 'Pagamento nao encontrado');
  }

  const balance = db.prepare(`
    SELECT amount_cve - COALESCE((
      SELECT SUM(r.amount_cve) FROM payment_receipts r
      WHERE r.payment_id = payments.id AND r.voided_at IS NULL
    ), 0) AS balanceCve
    FROM payments WHERE id = ?
  `).get(receipt.paymentId) as { balanceCve: number };
  const remaining = Math.round((Number(balance.balanceCve) || 0) * 100) / 100;

  const row: PaymentDocumentRow = {
    ...invoice,
    amountCve: receipt.amountCve,
    paymentDate: receipt.paymentDate,
    paymentMethod: receipt.paymentMethod,
    receiptNumber: receipt.receiptNumber,
    receiptDate: receipt.receiptDate,
    // O recibo prova um pagamento, mesmo que a fatura ainda tenha saldo.
    status: 'paid',
    notes: [
      invoice.notes?.trim(),
      receipt.source === 'credit' ? 'Liquidado por conta corrente.' : null,
      remaining > 0.005
        ? `Recebimento por conta da fatura ${invoice.invoiceNumber || invoice.referenceMonth}. Saldo em aberto: ${formatEscudos(remaining)}.`
        : null
    ].filter(Boolean).join('\n') || null
  };

  // Quando o recibo cobre a fatura toda, as linhas dela descrevem exactamente o
  // que se esta a receber. Num parcial nao descrevem — somariam mais do que o
  // recibo — por isso o documento leva uma linha unica pelo valor entregue.
  const invoiceLines = db.prepare(`
    SELECT kind, description, amount_cve AS amountCve
    FROM payment_lines
    WHERE payment_id = ?
    ORDER BY sort_order, id
  `).all(receipt.paymentId) as DocumentLine[];
  const linesTotal = invoiceLines.reduce((sum, line) => sum + Number(line.amountCve || 0), 0);
  const coversInvoice = Math.abs(linesTotal - receipt.amountCve) < 0.005;
  const lines: DocumentLine[] = coversInvoice && invoiceLines.length > 0
    ? invoiceLines
    : [{
        kind: 'internet',
        // Curto de proposito: a coluna trunca por volta dos 43 caracteres e o
        // numero da fatura e justamente a parte que nao pode desaparecer.
        description: `Por conta da fatura ${invoice.invoiceNumber || invoice.referenceMonth}`,
        amountCve: receipt.amountCve
      }];

  const buffer = await pdfBuffer(row, 'receipt', lines);
  return { buffer, filename: documentFilename('receipt', row) };
}

export class PaymentDocumentError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'PaymentDocumentError';
  }
}

/**
 * Single source of truth for a payment's invoice/receipt PDF: validates the
 * payment, enforces the same guards as the HTTP routes, assigns the document
 * number if missing, and returns the rendered buffer + filename. Used by the
 * HTTP routes and the WhatsApp outbox worker. Throws PaymentDocumentError with
 * the HTTP status the routes should surface.
 */
export async function renderPaymentDocumentPdf(id: number, kind: DocumentKind): Promise<{ buffer: Buffer; filename: string }> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new PaymentDocumentError(400, 'Pagamento invalido');
  }
  const db = getSqliteDatabase();
  let row = db.prepare(documentSelect).get(id) as PaymentDocumentRow | undefined;
  if (!row) {
    throw new PaymentDocumentError(404, 'Pagamento nao encontrado');
  }
  if (row.status === 'cancelled') {
    throw new PaymentDocumentError(400, kind === 'invoice' ? 'Pagamento anulado nao pode gerar fatura' : 'Pagamento anulado nao pode gerar recibo');
  }
  if (kind === 'receipt') {
    // Com recebimentos parciais, o recibo da fatura e o ultimo que foi emitido
    // — nao ha razao para exigir que ela esteja fechada: quem entregou 10.000
    // tem direito a prova dos 10.000 hoje, nao no dia em que acabar de pagar.
    const latest = db.prepare(`
      SELECT id FROM payment_receipts
      WHERE payment_id = ? AND voided_at IS NULL
      ORDER BY payment_date DESC, id DESC LIMIT 1
    `).get(id) as { id: number } | undefined;
    if (latest) {
      return renderReceiptPdf(latest.id);
    }
    if (row.status !== 'paid') {
      throw new PaymentDocumentError(400, 'So e possivel gerar recibo depois do pagamento');
    }
  }
  if (kind === 'invoice' && !hasDocumentNumber(row.invoiceNumber)) {
    // Allocation + write share one transaction so the sequence counter never
    // advances without the number landing on the row.
    db.transaction(() => {
      db.prepare(`
        UPDATE payments
        SET invoice_number = ?, invoice_date = COALESCE(invoice_date, date('now')), updated_at = datetime('now')
        WHERE id = ?
      `).run(allocateDocumentNumber('invoice'), id);
    })();
    row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
  }
  if (kind === 'receipt' && !row.receiptNumber) {
    db.transaction(() => {
      db.prepare(`
        UPDATE payments
        SET receipt_number = ?, receipt_date = COALESCE(receipt_date, date('now')), updated_at = datetime('now')
        WHERE id = ?
      `).run(allocateDocumentNumber('receipt'), id);
    })();
    row = db.prepare(documentSelect).get(id) as PaymentDocumentRow;
  }
  const lines = db.prepare(`
    SELECT kind, description, amount_cve AS amountCve
    FROM payment_lines
    WHERE payment_id = ?
    ORDER BY sort_order, id
  `).all(id) as DocumentLine[];
  const buffer = await pdfBuffer(row, kind, lines);
  return { buffer, filename: documentFilename(kind, row) };
}


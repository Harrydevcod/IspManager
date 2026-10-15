import { formatCentavos } from '../../shared/money';
import { INFORMATIVE_TYPE_LABELS, PROPOSAL_STATUS_LABELS, type Proposal, type ProposalCompany, type ProposalTax, type DocumentBankAccount } from '../../shared/proposals';
import { computeTotals, loadCompany, PALETTE, PaymentDocumentError, productNotes } from './documents';

const PDFDocument = require('pdfkit');
export type ProposalFormat = 'a4' | 'a5';

/** Drafts preview current settings; issued offers only read the frozen snapshot. */
export async function renderProposalPdf(id: number, format: ProposalFormat = 'a4'): Promise<{ buffer: Buffer; filename: string }> {
  const { getProposal } = await import('./proposals');
  const proposal = getProposal(id);
  return { buffer: await buildProposalPdf(proposal, proposal.status === 'draft' ? loadCompany() : undefined, format), filename: `${proposal.number || `${proposal.documentType ?? "proposal"}-rascunho-${id}`}.pdf` };
}

export function buildProposalPdf(proposal: Proposal, previewCompany?: ProposalCompany & {bankAccounts?: DocumentBankAccount[]}, format: ProposalFormat = 'a4'): Promise<Buffer> {
  if (format !== 'a4' && format !== 'a5') return Promise.reject(new PaymentDocumentError(400, 'Formato inválido: use a4 ou a5'));
  const a5 = format === 'a5';
  const M = a5 ? 28 : 44;
  const W = a5 ? 419.53 : 595.28;
  const H = a5 ? 595.28 : 841.89;
  const BOTTOM = H - (a5 ? 55 : 65);
  const CW = W - M * 2;
  // Cód. · Descrição · Qtd. · Preço unit. · Valor.
  const codeWidth = CW * 0.13 - 6;
  const descX = M + CW * 0.14;
  const descWidth = CW * 0.35;
  const qtyX = M + CW * 0.51;
  const unitX = M + CW * 0.61;
  const amountX = M + CW * 0.81;
  const rowLineHeight = a5 ? 12 : 14;
  if (proposal.status !== 'draft' && !proposal.snapshot) return Promise.reject(new Error('Issued proposal requires a frozen snapshot'));
  const company = proposal.status === 'draft' ? previewCompany ?? proposal.snapshot?.company : proposal.snapshot?.company;
  const label = INFORMATIVE_TYPE_LABELS[proposal.documentType ?? 'proposal'];
  const disclaimer = `${label}${proposal.documentType === 'proforma' ? ' — não constitui fatura fiscal' : ' - não constitui fatura'}`;
  const payment = proposal.status === 'draft' ? proposal.paymentRequest : proposal.snapshot?.paymentRequest;
  const bankAccounts = proposal.status === 'draft' ? previewCompany?.bankAccounts ?? [] : proposal.snapshot?.bankAccounts ?? [];
  if (!company) return Promise.reject(new Error('Draft proposal requires company preview settings'));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margins: { top: M, left: M, right: M, bottom: 20 }, bufferPages: true, autoFirstPage: false, info: { Title: proposal.title, Author: company.companyName, Subject: disclaimer } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    let y = 0;
    const number = proposal.number || 'RASCUNHO';
    const date = (value: string | null) => value ? value.slice(0, 10).split('-').reverse().join('/') : '-';
    const money = (value: number) => company.currencyCode === 'CVE' ? formatCentavos(value) : `${(value / 100).toFixed(2)} ${company.currencyCode}`;
    const font = (size = 9, bold = false, color = PALETTE.ink) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
    // Explicit wrapping also handles a single arbitrarily long address or URL.
    const wrap = (value: string, width: number, size = 9, bold = false): string[] => {
      font(size, bold);
      return value.replace(/\r/g, '').split('\n').flatMap((paragraph) => {
        const output: string[] = []; let line = '';
        for (const word of paragraph.split(/\s+/)) {
          if (!word) continue;
          if (line && doc.widthOfString(`${line} ${word}`) > width) { output.push(line); line = ''; }
          let part = '';
          for (const char of word) {
            if (doc.widthOfString(part + char) > width && part) { output.push(part); part = ''; }
            part += char;
          }
          line = line ? `${line} ${part}` : part;
        }
        output.push(line); return output;
      });
    };
    const single = (text: string, x: number, top: number, width: number, size = 9, bold = false, align: 'left' | 'right' = 'left', color = PALETTE.ink) => {
      font(size, bold, color);
      const measured = doc.widthOfString(text);
      if (measured > width) doc.fontSize(size * width / measured);
      doc.text(text, x, top, { width, lineBreak: false, align });
    };
    const page = () => {
      doc.addPage();
      doc.rect(0, 0, W, H).fill(PALETTE.paper);
      single(`ISPM / ${label.toLocaleUpperCase('pt')}`,  M, M, CW - 145, 8, true, 'left', PALETTE.accent);
      single(number, W - M - 145, M, 145, 8, true, 'right');
      doc.moveTo(M, M + 20).lineTo(W - M, M + 20).strokeColor(PALETTE.hairline).lineWidth(0.6).stroke();
      y = M + 32;
      if (['draft', 'superseded', 'cancelled'].includes(proposal.status)) {
        doc.rect(M, y, CW, 26).fill(PALETTE.paperTint2);
        single(PROPOSAL_STATUS_LABELS[proposal.status].toLocaleUpperCase('pt'), M + 10, y + 8, CW - 20, 9, true, 'left', proposal.status === 'cancelled' ? PALETTE.danger : PALETTE.accent);
        y += a5 ? 32 : 39;
      }
    };
    const ensure = (height: number) => { if (y + height > BOTTOM) page(); };
    const paragraph = (value: string, size = 9, bold = false, color = PALETTE.ink, width = CW) => {
      const lines = wrap(value, width, size, bold);
      for (const line of lines) { ensure(size * 1.4); single(line, M, y, width, size, bold, 'left', color); y += size * 1.4; }
    };
    const heading = (value: string, keep = 26) => { ensure(keep + (a5 ? 22 : 28)); y += a5 ? 4 : 12; paragraph(value, a5 ? 10 : 13, true); y += a5 ? 4 : 8; };
    const tableHeader = () => {
      doc.rect(M, y, CW, 23).fill(PALETTE.paperTint2);
      single('Cód.', M + 6, y + 7, codeWidth, 8, true);
      single('Descrição', descX, y + 7, descWidth, 8, true);
      single('Qtd.', qtyX, y + 7, CW * 0.08, 8, true, 'right');
      single('Preço unit.', unitX, y + 7, CW * 0.18, 8, true, 'right');
      single('Valor', amountX, y + 7, CW * 0.19 - 6, 8, true, 'right'); y += a5 ? 24 : 30;
    };
    const taxPreview = (total: number): ProposalTax => {
      const result = computeTotals(total / 100, { ...company, bankAccounts: [], printQrCode: false, printRentalLines: false, productPolicy: '' });
      const subtotal = Math.round(result.subtotal * 100);
      return { subtotalCentavos: subtotal, ivaCentavos: total - subtotal, totalCentavos: total, ivaRate: result.ivaRate, isExempt: result.isExempt, exemptReason: result.exemptReason };
    };
    page();
    const rightWidth = CW * 0.42;
    const rightX = W - M - rightWidth;
    const leftWidth = CW - rightWidth - 20;
    const partyLines = (values: string[], width: number) => values.flatMap((value, index) => {
      const size = index === 0 ? 11 : 8;
      return wrap(value, width, size, index === 0).map(text => ({ text, size, bold: index === 0 }));
    });
    const issuer = partyLines([company.companyName, company.nif ? `NIF ${company.nif}` : '', company.address, company.island, company.phone, company.email].filter(Boolean), leftWidth);
    const recipient = partyLines([proposal.recipient.name, proposal.recipient.nif ? `NIF ${proposal.recipient.nif}` : '', proposal.recipient.address, proposal.recipient.phone, proposal.recipient.email].filter(Boolean), rightWidth);
    ensure(45);
    const partyLabels = () => {
      single('EMITENTE', M, y, leftWidth, 8, true, 'left', PALETTE.accent);
      single('CLIENTE', rightX, y, rightWidth, 8, true, 'left', PALETTE.accent);
      y += 14;
    };
    partyLabels();
    for (let i = 0; i < Math.max(issuer.length, recipient.length); i++) {
      const rowHeight = Math.max(issuer[i]?.size ?? 0, recipient[i]?.size ?? 0) * (a5 ? 1.3 : 1.4);
      if (y + rowHeight > BOTTOM) { page(); partyLabels(); }
      if (issuer[i]) single(issuer[i].text, M, y, leftWidth, issuer[i].size, issuer[i].bold, 'left', issuer[i].bold ? PALETTE.ink : PALETTE.muted);
      if (recipient[i]) single(recipient[i].text, rightX, y, rightWidth, recipient[i].size, recipient[i].bold, 'left', recipient[i].bold ? PALETTE.ink : PALETTE.muted);
      y += rowHeight;
    }
    y += a5 ? 6 : 13;
    paragraph(disclaimer, 8, true, PALETTE.accent); y += a5 ? 4 : 12;
    paragraph(`Emissão: ${date(proposal.issuedAt)}   |   Validade: ${date(proposal.validUntil)}   |   Moeda: ${company.currencyCode}`, 8);
    paragraph(`Estado: ${PROPOSAL_STATUS_LABELS[proposal.status]}`, 8);
    const previous = proposal.chain.find((p) => p.id === proposal.previousId);
    const replacement = proposal.chain.find((p) => p.previousId === proposal.id && p.number);
    if (previous) paragraph(`Revisão de ${previous.number || 'rascunho'}`, 9);
    if (replacement) paragraph(`Substituída por ${replacement.number}`, 9, true, PALETTE.accent);
    for (const period of ['once', 'monthly'] as const) {
      const lines = proposal.lines.filter((line) => line.period === period);
      heading(period === 'once' ? 'Custos únicos' : 'Mensalidades', 45); tableHeader();
      if (!lines.length) paragraph('Sem custos neste período.', 9, false, PALETTE.muted);
      for (const line of lines) {
        const wrapped = wrap(line.description, descWidth, a5 ? 8.5 : 9);
        const rowHeight = wrapped.length * rowLineHeight + (a5 ? 5 : 10);
        // Keep ordinary rows together; split only descriptions taller than a page.
        if (y + rowHeight > BOTTOM && rowHeight <= BOTTOM - (M + 110)) {
          page(); paragraph(`${period === 'once' ? 'Custos únicos' : 'Mensalidades'} (continuação)`, 11, true); y += 8; tableHeader();
        }
        let first = true;
        for (let index = 0; index < wrapped.length;) {
          if (y + 24 > BOTTOM) { page(); paragraph(`${period === 'once' ? 'Custos únicos' : 'Mensalidades'} (continuação)`, 11, true); y += 8; tableHeader(); }
          const count = Math.min(wrapped.length - index, Math.floor((BOTTOM - y - 10) / rowLineHeight));
          for (let offset = 0; offset < count; offset++) single(wrapped[index + offset], descX, y + offset * rowLineHeight, descWidth, a5 ? 8.5 : 9);
          if (first) {
            single(line.itemCode || '-', M + 6, y, codeWidth, a5 ? 7.5 : 8, false, 'left', PALETTE.muted);
            single(String(line.quantity).replace('.', ','), qtyX, y, CW * 0.08, 9, false, 'right');
            single(money(line.unitPriceCentavos), unitX, y, CW * 0.18, 9, false, 'right');
            single(money(line.totalCentavos), amountX, y, CW * 0.19 - 6, 9, true, 'right'); first = false;
          }
          y += count * rowLineHeight + (a5 ? 5 : 10); index += count;
        }
        doc.moveTo(M, y - 4).lineTo(W - M, y - 4).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
      }
      const total = period === 'once' ? proposal.onceTotalCentavos : proposal.monthlyTotalCentavos;
      const tax = (period === 'once' ? proposal.snapshot?.onceTax : proposal.snapshot?.monthlyTax) ?? taxPreview(total);
      ensure(a5 ? 68 : 94); y += a5 ? 4 : 8;
      if (company.showIva) {
        paragraph(`Base tributável: ${money(tax.subtotalCentavos)}`, 8, false, PALETTE.muted);
        paragraph(tax.isExempt ? tax.exemptReason : `IVA incluído (${tax.ivaRate}%): ${money(tax.ivaCentavos)}`, 8, false, PALETTE.muted);
      }
      doc.moveTo(M, y + 4).lineTo(W - M, y + 4).strokeColor(PALETTE.accent).lineWidth(1).stroke(); y += a5 ? 11 : 14;
      const totalWidth = Math.min(180, CW * 0.42);
      single(period === 'once' ? 'Total de custos únicos' : 'Total mensal', M, y, CW - totalWidth - 12, a5 ? 10 : 11, true);
      single(money(total), W - M - totalWidth, y - 3, totalWidth, a5 ? 14 : 17, true, 'right', PALETTE.accent); y += a5 ? 22 : 31;
    }
    if (proposal.documentType === 'proforma' && payment) {
      heading('Pedido de pagamento antecipado', 70);
      paragraph(`${formatCentavos(payment.amountCentavos)} CVE`, a5 ? 14 : 17, true, PALETTE.accent);
      heading('O que este pagamento cobre'); paragraph(payment.description);
      heading('Condições de pagamento'); paragraph(payment.conditions);
      if (payment.dueDate) { y += 8; paragraph(`Data limite de pagamento: ${date(payment.dueDate)}`, 9, true); }
      if (bankAccounts.length) {
        heading('Contas bancárias');
        for (const account of bankAccounts) {
          paragraph([account.bankName, account.accountName, account.accountNumber, account.reference].filter(Boolean).join(' · '), 9);
          y += 4;
        }
      }
    }
    const productText = productNotes(proposal.lines.map((line) => ({ ...line, isProduct: line.kind === 'product' })), company);
    if (productText.length) { heading('Garantias e condições dos produtos'); for (const note of productText) paragraph(note, 9); }
    if (proposal.conditions) { heading('Condições comerciais'); paragraph(proposal.conditions); }
    if (company.legalNotes) { heading('Informação comercial', a5 ? 12 : 26); paragraph(company.legalNotes, 8, false, PALETTE.muted); }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.moveTo(M, H - 47).lineTo(W - M, H - 47).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
      single(disclaimer, M, H - 35, CW - 90, 7, false, 'left', PALETTE.muted);
      single(`Página ${i + 1} / ${range.count}`, W - M - 90, H - 35, 90, 7, false, 'right', PALETTE.muted);
    }
    doc.end();
  });
}

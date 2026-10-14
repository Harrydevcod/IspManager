import { formatCentavos } from '../../shared/money';
import { PROPOSAL_STATUS_LABELS, type Proposal, type ProposalCompany, type ProposalTax } from '../../shared/proposals';
import { computeTotals, loadCompany, PALETTE } from './documents';

const PDFDocument = require('pdfkit');
const M = 44;
const W = 595.28;
const BOTTOM = 777;
const CW = W - M * 2;

/** Drafts preview current settings; issued offers only read the frozen snapshot. */
export async function renderProposalPdf(id: number): Promise<{ buffer: Buffer; filename: string }> {
  const { getProposal } = await import('./proposals');
  const proposal = getProposal(id);
  return { buffer: await buildProposalPdf(proposal, proposal.status === 'draft' ? loadCompany() : undefined), filename: `${proposal.number || `proposta-rascunho-${id}`}.pdf` };
}

export function buildProposalPdf(proposal: Proposal, previewCompany?: ProposalCompany): Promise<Buffer> {
  if (proposal.status !== 'draft' && !proposal.snapshot) return Promise.reject(new Error('Issued proposal requires a frozen snapshot'));
  const company = proposal.snapshot?.company ?? previewCompany;
  if (!company) return Promise.reject(new Error('Draft proposal requires company preview settings'));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 20 }, bufferPages: true, autoFirstPage: false, info: { Title: proposal.title, Author: company.companyName, Subject: 'Proposta comercial - não constitui fatura' } });
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
      doc.rect(0, 0, W, 841.89).fill(PALETTE.paper);
      single('ISPM / PROPOSTA COMERCIAL', M, 30, CW - 145, 8, true, 'left', PALETTE.accent);
      single(number, W - M - 145, 30, 145, 8, true, 'right');
      doc.moveTo(M, 50).lineTo(W - M, 50).strokeColor(PALETTE.hairline).lineWidth(0.6).stroke();
      y = 67;
      if (['draft', 'superseded', 'cancelled'].includes(proposal.status)) {
        doc.rect(M, y, CW, 26).fill(PALETTE.paperTint2);
        single(PROPOSAL_STATUS_LABELS[proposal.status].toLocaleUpperCase('pt'), M + 10, y + 8, CW - 20, 9, true, 'left', proposal.status === 'cancelled' ? PALETTE.danger : PALETTE.accent);
        y += 39;
      }
    };
    const ensure = (height: number) => { if (y + height > BOTTOM) page(); };
    const paragraph = (value: string, size = 9, bold = false, color = PALETTE.ink, width = CW) => {
      const lines = wrap(value, width, size, bold);
      for (const line of lines) { ensure(size * 1.5); single(line, M, y, width, size, bold, 'left', color); y += size * 1.5; }
    };
    const heading = (value: string, keep = 40) => { ensure(keep + 28); y += 12; paragraph(value, 13, true); y += 8; };
    const tableHeader = () => {
      doc.rect(M, y, CW, 23).fill(PALETTE.paperTint2);
      single('Descrição', M + 8, y + 7, 250, 8, true);
      single('Qtd.', M + 268, y + 7, 40, 8, true, 'right');
      single('Preço unit.', M + 313, y + 7, 87, 8, true, 'right');
      single('Valor', M + 405, y + 7, CW - 413, 8, true, 'right'); y += 30;
    };
    const taxPreview = (total: number): ProposalTax => {
      const result = computeTotals(total / 100, { ...company, bankAccounts: [], printQrCode: false, printRentalLines: false });
      const subtotal = Math.round(result.subtotal * 100);
      return { subtotalCentavos: subtotal, ivaCentavos: total - subtotal, totalCentavos: total, ivaRate: result.ivaRate, isExempt: result.isExempt, exemptReason: result.exemptReason };
    };
    page();
    paragraph(company.companyName, 20, true);
    paragraph([company.address, company.island, company.nif ? `NIF ${company.nif}` : '', company.phone, company.email].filter(Boolean).join(' | '), 8, false, PALETTE.muted); y += 13;
    paragraph(proposal.title, 24, true);
    paragraph('Proposta comercial - não constitui fatura', 9, true, PALETTE.accent); y += 12;
    paragraph(`Emissão: ${date(proposal.issuedAt)}   |   Validade: ${date(proposal.validUntil)}   |   Moeda: ${company.currencyCode}`, 9);
    paragraph(`Estado: ${PROPOSAL_STATUS_LABELS[proposal.status]}`, 9);
    const previous = proposal.chain.find((p) => p.id === proposal.previousId);
    const replacement = proposal.chain.find((p) => p.previousId === proposal.id && p.number);
    if (previous) paragraph(`Revisão de ${previous.number || 'rascunho'}`, 9);
    if (replacement) paragraph(`Substituída por ${replacement.number}`, 9, true, PALETTE.accent);
    heading('Preparada para', 55);
    paragraph(proposal.recipient.name, 12, true);
    paragraph([proposal.recipient.nif ? `NIF ${proposal.recipient.nif}` : '', proposal.recipient.address, proposal.recipient.phone, proposal.recipient.email].filter(Boolean).join(' | '), 9, false, PALETTE.muted);
    for (const period of ['once', 'monthly'] as const) {
      const lines = proposal.lines.filter((line) => line.period === period);
      heading(period === 'once' ? 'Custos únicos' : 'Mensalidades', 75); tableHeader();
      if (!lines.length) paragraph('Sem custos neste período.', 9, false, PALETTE.muted);
      for (const line of lines) {
        const wrapped = wrap(line.description, 250);
        const rowHeight = wrapped.length * 14 + 10;
        // Keep ordinary rows together; split only descriptions taller than a page.
        if (y + rowHeight > BOTTOM && rowHeight <= 600) {
          page(); paragraph(`${period === 'once' ? 'Custos únicos' : 'Mensalidades'} (continuação)`, 11, true); y += 8; tableHeader();
        }
        let first = true;
        for (let index = 0; index < wrapped.length;) {
          if (y + 24 > BOTTOM) { page(); paragraph(`${period === 'once' ? 'Custos únicos' : 'Mensalidades'} (continuação)`, 11, true); y += 8; tableHeader(); }
          const count = Math.min(wrapped.length - index, Math.floor((BOTTOM - y - 10) / 14));
          for (let offset = 0; offset < count; offset++) single(wrapped[index + offset], M + 8, y + offset * 14, 250);
          if (first) {
            single(String(line.quantity).replace('.', ','), M + 268, y, 40, 9, false, 'right');
            single(money(line.unitPriceCentavos), M + 313, y, 87, 9, false, 'right');
            single(money(line.totalCentavos), M + 405, y, CW - 413, 9, true, 'right'); first = false;
          }
          y += count * 14 + 10; index += count;
        }
        doc.moveTo(M, y - 4).lineTo(W - M, y - 4).strokeColor(PALETTE.hairline).lineWidth(0.4).stroke();
      }
      const total = period === 'once' ? proposal.onceTotalCentavos : proposal.monthlyTotalCentavos;
      const tax = (period === 'once' ? proposal.snapshot?.onceTax : proposal.snapshot?.monthlyTax) ?? taxPreview(total);
      ensure(94); y += 8;
      if (company.showIva) {
        paragraph(`Base tributável: ${money(tax.subtotalCentavos)}`, 8, false, PALETTE.muted);
        paragraph(tax.isExempt ? tax.exemptReason : `IVA incluído (${tax.ivaRate}%): ${money(tax.ivaCentavos)}`, 8, false, PALETTE.muted);
      }
      doc.moveTo(M, y + 4).lineTo(W - M, y + 4).strokeColor(PALETTE.accent).lineWidth(1).stroke(); y += 14;
      single(period === 'once' ? 'Total de custos únicos' : 'Total mensal', M, y, CW - 180, 11, true);
      single(money(total), W - M - 180, y - 3, 180, 17, true, 'right', PALETTE.accent); y += 31;
    }
    if (proposal.conditions) { heading('Condições comerciais'); paragraph(proposal.conditions); }
    if (company.legalNotes) { heading('Informação comercial'); paragraph(company.legalNotes, 8, false, PALETTE.muted); }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.moveTo(M, 795).lineTo(W - M, 795).strokeColor(PALETTE.hairline).lineWidth(0.5).stroke();
      single('Proposta comercial - não constitui fatura', M, 807, CW - 90, 7, false, 'left', PALETTE.muted);
      single(`Página ${i + 1} / ${range.count}`, W - M - 90, 807, 90, 7, false, 'right', PALETTE.muted);
    }
    doc.end();
  });
}

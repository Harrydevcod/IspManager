import { describe, expect, test } from 'vitest';
import { inflateSync } from 'node:zlib';
import type { Proposal, ProposalCompany } from '../../shared/proposals';
import { buildProposalPdf } from './proposal-documents';
import { inspectPdfLayout } from './pdf.testing';

export const company: ProposalCompany = { companyName: 'ISPM ORIGINAL', nif: '123456789', phone: '555123', email: 'info@example.cv', address: 'Praia', island: 'Santiago', currencyCode: 'CVE', ivaRate: 15, fiscalRegime: 'normal', showIva: true, legalNotes: 'Oferta comercial.' };
export function fixture(): Proposal {
  return { documentType: 'proposal', paymentRequest: null, id: 1, number: 'PR-2026-00001', title: 'Internet para casa', recipientName: 'Maria Original', recipient: { name: 'Maria Original', nif: '', phone: '', email: '', address: 'Praia' }, clientId: null, status: 'issued', version: 2, validUntil: '2026-11-12', issuedAt: '2026-10-13T12:00:00Z', createdAt: '2026-10-13', onceTotalCentavos: 100000, monthlyTotalCentavos: 250000, previousId: null, conditions: 'Instalação mediante agendamento.', lines: [{ id: 1, sortOrder: 0, kind: 'installation', description: 'Instalação oferecida', period: 'once', quantity: 1, unitPriceCentavos: 0, totalCentavos: 0 }, { id: 2, sortOrder: 1, kind: 'product', description: 'Router vendido', period: 'once', quantity: 1, unitPriceCentavos: 100000, totalCentavos: 100000 }, { id: 3, sortOrder: 2, kind: 'plan', description: 'Plano mensal original', period: 'monthly', quantity: 1, unitPriceCentavos: 250000, totalCentavos: 250000 }], snapshot: { company, onceTax: { subtotalCentavos: 86957, ivaCentavos: 13043, totalCentavos: 100000, ivaRate: 15, isExempt: false, exemptReason: '' }, monthlyTax: { subtotalCentavos: 217391, ivaCentavos: 32609, totalCentavos: 250000, ivaRate: 15, isExempt: false, exemptReason: '' } }, createdBy: 1, decisionAt: null, acceptedBy: null, decisionNote: null, cancellationReason: null, deliveries: [], chain: [], allowedActions: [] };
}
// PDFKit encodes standard-font strings as WinAnsi hex inside deflated streams.
function content(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((match) => {
    let stream: string;
    try { stream = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { return ''; }
    return [...stream.matchAll(/<([\da-f]+)>/gi)].map((hex) => Buffer.from(hex[1], 'hex').toString('latin1')).join('');
  }).join('\n');
}
describe('proposal PDF', () => {
  test.each(['a4', 'a5'] as const)('%s omits generic and custom titles from the body of drafts and issued proposals', async (format) => {
    for (const title of ['Proposta comercial', 'Internet para casa']) {
      for (const status of ['draft', 'issued'] as const) {
        const proposal = { ...fixture(), title, status };
        const pdf = await buildProposalPdf(proposal, company, format);
        const layout = inspectPdfLayout(pdf);
        const text = layout.text.flat().map(item => item.value);
        expect(text).not.toContain(title);
        expect(content(pdf)).toContain('Proposta comercial - não constitui fatura');
        expect(content(pdf)).toContain('Maria Original');
        expect(content(pdf)).toContain('1.000$00');
        expect(content(pdf)).toContain('2.500$00');
      }
    }
  });
  test.each(['a4', 'a5'] as const)('%s aligns issuer and recipient side by side', async (format) => {
    const pdf = await buildProposalPdf(fixture(), undefined, format);
    const layout = inspectPdfLayout(pdf);
    const issuer = layout.text[0].find(text => text.value === 'EMITENTE')!;
    const client = layout.text[0].find(text => text.value === 'CLIENTE')!;
    expect(issuer).toBeDefined();
    expect(client).toBeDefined();
    expect(client.x).toBeGreaterThan(issuer.x + 100);
    expect(client.y).toBeCloseTo(issuer.y, 2);
    expect(layout.pages[0]).toEqual(format === 'a5' ? [0, 0, 419.53, 595.28] : [0, 0, 595.28, 841.89]);
  });
  test('short A5 proposal fits on one page and preserves both price periods', async () => {
    const pdf = await buildProposalPdf(fixture(), undefined, 'a5');
    expect(inspectPdfLayout(pdf).pages).toHaveLength(1);
    for (const value of ['Maria Original', '1.000$00', '2.500$00', 'Instalação mediante agendamento.', 'Oferta comercial.']) expect(content(pdf)).toContain(value);
  });
  test.each(['a4', 'a5'] as const)('%s preserves long party details and oversized rows within every page', async (format) => {
    const proposal = fixture();
    proposal.snapshot!.company = { ...company, address: 'Morada extensa '.repeat(25) + 'FIM-EMITENTE' };
    proposal.recipient.address = 'Morada do destinatário '.repeat(25) + 'FIM-CLIENTE';
    proposal.lines[0].description = 'Descrição '.repeat(400) + 'FIM-ARTIGO';
    const pdf = await buildProposalPdf(proposal, undefined, format);
    const layout = inspectPdfLayout(pdf);
    for (const value of ['FIM-EMITENTE', 'FIM-CLIENTE', 'FIM-ARTIGO']) expect(content(pdf)).toContain(value);
    expect(layout.pages.length).toBeGreaterThan(1);
    layout.text.forEach((texts, i) => texts.forEach(text => {
      expect(text.x).toBeGreaterThanOrEqual(20);
      expect(text.x).toBeLessThan(layout.pages[i][2] - 20);
      expect(text.y).toBeGreaterThan(20);
      expect(text.y).toBeLessThan(layout.pages[i][3] - 20);
    }));
  });
  test('A4, frozen content, distinct periods, fiscal presentation and no QR image', async () => {
    const pdf = await buildProposalPdf(fixture(), { ...company, companyName: 'CHANGED COMPANY' });
    const text = content(pdf);
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBe(1);
    for (const value of ['ISPM ORIGINAL', 'Maria Original', 'PR-2026-00001', 'Custos únicos', 'Mensalidades', 'Instalação oferecida', '1.000$00', '2.500$00', 'IVA incluído', 'não constitui fatura']) expect(text).toContain(value);
    expect(text).not.toContain('CHANGED COMPANY');
    expect(text).not.toContain('3.500$00');
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
  });
  test('draft without final number and issued documents without snapshot are rejected', async () => {
    const draft = { ...fixture(), number: null, status: 'draft' as const, snapshot: null };
    expect(content(await buildProposalPdf(draft, company))).toContain('RASCUNHO');
    await expect(buildProposalPdf({ ...fixture(), snapshot: null }, company)).rejects.toThrow('snapshot');
  });
  test('long strings, many lines and conditions paginate; replacement remains clear', async () => {
    const proposal = fixture();
    proposal.status = 'superseded';
    proposal.chain = [{ ...proposal, id: 2, number: 'PR-2026-00002', previousId: 1 }];
    proposal.lines = Array.from({ length: 100 }, (_, i) => ({ ...proposal.lines[0], id: i + 1, sortOrder: i, description: `Oferta ${i} ${'ABCDEFGHIJ'.repeat(35)}` }));
    proposal.conditions = 'Condições comerciais extensas. '.repeat(300);
    const pdf = await buildProposalPdf(proposal);
    const text = content(pdf);
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(5);
    expect(text).toContain('Oferta 99');
    expect(text).toContain('SUBSTITUÍDA');
    expect(text).toContain('PR-2026-00002');
    expect(text).toContain('Página');
  });
  test('cancelled pending revision is not presented as an issued replacement', async () => {
    const proposal = fixture();
    proposal.chain = [{ ...proposal, id: 2, previousId: 1, number: null, status: 'cancelled' }];
    expect(content(await buildProposalPdf(proposal))).not.toContain('Substituída por');
  });
});

test.each(['a4','a5'] as const)('%s proforma paginates frozen instructions separately from offer totals', async format => {
  const p = fixture(); p.documentType = 'proforma';
  p.paymentRequest = {amountCentavos: 3000000, description: 'Doze mensalidades', conditions: 'Pagar na conta original. '.repeat(200), dueDate: null};
  p.snapshot!.paymentRequest = p.paymentRequest;
  p.snapshot!.bankAccounts = [{bankName:'Banco original',accountName:'Empresa',accountNumber:'123 ORIGINAL',reference:'PF'}];
  const pdf = await buildProposalPdf(p, {...company, bankAccounts: [{bankName:'Banco alterado',accountName:'',accountNumber:'NOVA',reference:''}]}, format);
  const text = content(pdf);
  expect(text).toContain('Fatura proforma'); expect(text).toContain('30.000$00');
  expect(text).toContain('Doze mensalidades'); expect(text).toContain('Banco original');
  expect(text).not.toContain('Banco alterado'); expect(text).not.toContain('Data limite');
  expect(inspectPdfLayout(pdf).pages.length).toBeGreaterThan(1);
});

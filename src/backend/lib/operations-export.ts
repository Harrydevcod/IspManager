import { getSqliteDatabase } from '../db/database';
import { formatPtDate, formatPtMonth } from '../../shared/date';
import { loadOperationsStatus } from './operations-status';
import { SEVERITY_LABELS, type OperationsSeverity, type OperationsStatus } from '../../shared/operations-status';

const PDFDocument = require('pdfkit');

/**
 * Relatório mensal do estado da operação.
 *
 * O painel serve o "agora"; este PDF serve o arquivo — a fotografia do fecho
 * do mês, para comparar meses e para mostrar a terceiros. Reutiliza o mesmo
 * read model do painel: uma só definição de verdade, dois formatos.
 */

const INK = '#1a1714';
const MUTED = '#6b6258';
const RULE = '#e1d6c0';
const SEVERITY_INK: Record<OperationsSeverity, string> = {
  green: '#2f7d4f',
  amber: '#b26a00',
  red: '#b3261e'
};

function cve(value: number): string {
  return `${Math.round(value).toLocaleString('pt-PT')} CVE`;
}

function pct(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

function loadCompanyName(): string {
  const row = getSqliteDatabase()
    .prepare(`SELECT value FROM app_settings WHERE key = 'companyName'`)
    .get() as { value: string } | undefined;
  return row?.value || 'ISPM';
}

type Doc = {
  page: { width: number; height: number };
  y: number;
  font: (name: string) => Doc;
  fontSize: (size: number) => Doc;
  fillColor: (color: string) => Doc;
  strokeColor: (color: string) => Doc;
  lineWidth: (width: number) => Doc;
  text: (text: string, x?: number, y?: number, options?: Record<string, unknown>) => Doc;
  moveTo: (x: number, y: number) => Doc;
  lineTo: (x: number, y: number) => Doc;
  stroke: () => Doc;
  addPage: () => Doc;
  heightOfString: (text: string, options?: Record<string, unknown>) => number;
  on: (event: string, handler: (chunk: Buffer) => void) => Doc;
  end: () => void;
};

const MARGIN = 40;

export async function buildOperationsStatusPdf(now: Date = new Date()): Promise<Buffer> {
  const status = loadOperationsStatus(getSqliteDatabase(), now);
  const company = loadCompanyName();

  return new Promise<Buffer>((resolve, reject) => {
    const doc: Doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject as (chunk: Buffer) => void);

    const width = doc.page.width;
    const content = width - MARGIN * 2;
    let y = MARGIN;

    /** Salta de página antes de escrever um bloco que não caberia inteiro. */
    function ensure(space: number): void {
      if (y + space <= doc.page.height - MARGIN) return;
      doc.addPage();
      y = MARGIN;
    }

    function rule(): void {
      doc.moveTo(MARGIN, y).lineTo(width - MARGIN, y).strokeColor(RULE).lineWidth(0.5).stroke();
      y += 12;
    }

    function heading(text: string): void {
      ensure(30);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
        .text(text.toUpperCase(), MARGIN, y, { width: content, characterSpacing: 1.2 });
      y += 14;
    }

    function paragraph(text: string, color = INK, size = 9): void {
      const height = doc.fontSize(size).heightOfString(text, { width: content });
      ensure(height + 6);
      doc.font('Helvetica').fontSize(size).fillColor(color).text(text, MARGIN, y, { width: content });
      y += height + 6;
    }

    function table(headers: string[], widths: number[], rows: string[][]): void {
      ensure(24);
      let x = MARGIN;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
      headers.forEach((header, index) => {
        doc.text(header.toUpperCase(), x, y, { width: content * widths[index] - 6, characterSpacing: 0.6 });
        x += content * widths[index];
      });
      y += 11;
      doc.moveTo(MARGIN, y).lineTo(width - MARGIN, y).strokeColor(RULE).lineWidth(0.3).stroke();
      y += 4;

      for (const row of rows) {
        const rowHeight = Math.max(
          ...row.map((cell, index) => doc.fontSize(8).heightOfString(cell, { width: content * widths[index] - 6 }))
        );
        ensure(rowHeight + 6);
        x = MARGIN;
        doc.font('Helvetica').fontSize(8).fillColor(INK);
        row.forEach((cell, index) => {
          doc.text(cell, x, y, { width: content * widths[index] - 6 });
          x += content * widths[index];
        });
        y += rowHeight + 5;
      }
      y += 6;
    }

    // ---- cabeçalho
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text('ESTADO DA OPERACAO', MARGIN, y, { width: content, characterSpacing: 1.8 });
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(company, MARGIN, y + 12);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text(`${formatPtMonth(status.period.to.slice(0, 7))} · gerado em ${formatPtDate(status.period.to)}`, MARGIN, y + 36);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(SEVERITY_INK[status.severity])
      .text(SEVERITY_LABELS[status.severity].toUpperCase(), MARGIN, y + 36, { width: content, align: 'right' });
    y += 62;
    rule();

    paragraph(status.headline, INK, 10);
    y += 4;

    // ---- indicadores
    const kpis: Array<[string, string]> = [
      ['Clientes ativos', String(status.customers.active)],
      ['MRR contratado', cve(status.customers.mrrCve)],
      ['Recebido (7 dias)', cve(status.billing.receivedThisWeekCve)],
      ['Vencido', cve(status.billing.wallet.overdueCve)]
    ];
    ensure(46);
    const colWidth = content / kpis.length;
    kpis.forEach(([label, value], index) => {
      const x = MARGIN + colWidth * index;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
        .text(label.toUpperCase(), x, y, { width: colWidth - 8, characterSpacing: 1 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
        .text(value, x, y + 10, { width: colWidth - 8 });
    });
    y += 42;
    rule();

    // ---- rede
    heading('Rede');
    if (status.network.devices.length === 0) {
      paragraph('Sem equipamentos de backbone registados.', MUTED);
    } else {
      table(
        ['Equipamento', 'Alimentado por', 'Clientes', 'MRR', 'Quota'],
        [0.3, 0.28, 0.12, 0.16, 0.14],
        status.network.devices.map((device) => [
          device.name,
          device.upstreamNames.join(', ') || 'raiz (sem uplink)',
          String(device.clientCount),
          cve(device.mrrCve),
          pct(device.mrrShare)
        ])
      );
    }
    const ident = status.network.identification;
    paragraph(
      `Identificação: ${ident.backboneWithIp}/${ident.backboneTotal} backbone com IP, ${ident.backboneWithMac}/${ident.backboneTotal} com MAC. `
      + `Parque em campo: ${ident.assignmentWithIp}/${ident.assignmentTotal} com IP, ${ident.assignmentWithMac}/${ident.assignmentTotal} com MAC.`,
      MUTED
    );

    // ---- cobrança
    heading('Cobrança');
    if (status.billing.collection.length > 0) {
      table(
        ['Competência', 'Emitido', 'Cobrado', 'Taxa'],
        [0.3, 0.24, 0.24, 0.22],
        status.billing.collection.map((cycle) => [
          formatPtMonth(cycle.referenceMonth),
          cve(cycle.issuedCve),
          cve(cycle.collectedCve),
          pct(cycle.rate)
        ])
      );
    }
    if (status.billing.debtors.length > 0) {
      heading('Devedores');
      table(
        ['Cliente', 'Contacto', 'Títulos', 'Valor', 'Dias'],
        [0.32, 0.22, 0.12, 0.2, 0.14],
        status.billing.debtors.slice(0, 15).map((debtor) => [
          debtor.clientName + (debtor.clientCancelled ? ' (cancelado)' : ''),
          debtor.phone || 'sem telefone',
          String(debtor.payments),
          cve(debtor.amountCve),
          String(debtor.maxDaysOverdue)
        ])
      );
    }

    // ---- parque
    const relevantFleet = status.fleet.models.filter((model) => model.deployed > 0 || model.stock > 0);
    if (relevantFleet.length > 0) {
      heading('Parque e stock');
      table(
        ['Modelo', 'Tipo', 'Em campo', 'Stock'],
        [0.44, 0.2, 0.18, 0.18],
        relevantFleet.map((model) => [
          model.label,
          model.type,
          String(model.deployed),
          `${model.stock} ${model.unitOfMeasure}`
        ])
      );
    }

    // ---- riscos
    if (status.risks.length > 0) {
      heading('Riscos');
      table(
        ['Código', 'Risco', 'Nível', 'Exposição'],
        [0.14, 0.5, 0.16, 0.2],
        status.risks.map((risk) => [
          risk.code,
          `${risk.title}. ${risk.detail}`,
          SEVERITY_LABELS[risk.severity],
          risk.exposureCve === null ? '-' : cve(risk.exposureCve)
        ])
      );
    }

    // ---- ações
    if (status.actions.length > 0) {
      const horizons: Array<[OperationsStatus['actions'][number]['horizon'], string]> = [
        ['now', 'Agora'],
        ['week', 'Esta semana'],
        ['quarter', 'Próximos meses']
      ];
      heading('Próximas ações');
      for (const [horizon, label] of horizons) {
        const items = status.actions.filter((action) => action.horizon === horizon);
        if (items.length === 0) continue;
        ensure(20);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(label, MARGIN, y, { width: content });
        y += 12;
        table(
          ['Código', 'Ação', 'Ganho'],
          [0.14, 0.66, 0.2],
          items.map((action) => [
            action.code,
            `${action.title}. ${action.detail}`,
            action.upsideCve === null ? '-' : cve(action.upsideCve)
          ])
        );
      }
    }

    // ---- nota de método
    ensure(40);
    rule();
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
      'Riscos e ações são derivados dos dados no momento da geração, não de uma lista fixa: resolvido o problema, a linha desaparece. '
      + 'As secções de desempenho de rede são qualitativas — o sistema regista topologia e inventário, mas não recolhe sinal, débito nem uptime.',
      MARGIN, y, { width: content }
    );

    doc.end();
  });
}

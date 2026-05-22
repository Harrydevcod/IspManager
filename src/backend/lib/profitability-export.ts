import ExcelJS from 'exceljs';
import { getSqliteDatabase } from '../db/database';
import { loadCompanyOpexContext } from './opex';

const PDFDocument = require('pdfkit');

type ReportInvestmentRow = {
  id: number;
  name: string;
  type: string;
  zone: string | null;
  clientName: string | null;
  status: string;
  investmentDate: string;
  totalCostCve: number;
  installedClients: number;
  targetClients: number;
  expectedMonthlyRevenueCve: number;
  imputedMonthlyOpexCve: number;
  directAllocatedOpexCve: number;
  effectiveMonthlyOpexCve: number;
  actualMonthlyRevenueCve: number | null;
  monthlyNetProfitCve: number;
  recoveryMonths: number | null;
  roiPct: number | null;
  isRecovered: number;
};

type ReportExpenseRow = {
  id: number;
  expenseDate: string;
  referenceMonth: string;
  category: string;
  description: string;
  supplier: string | null;
  amountCve: number;
  investmentName: string | null;
  zone: string | null;
  clientName: string | null;
};

type CompanyInfo = { companyName: string; nif: string; currencyCode: string };

function loadCompany(): CompanyInfo {
  const db = getSqliteDatabase();
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key IN ('companyName','nif','currencyCode')`).all() as Array<{ key: string; value: string }>;
  const out: CompanyInfo = { companyName: 'ISPM', nif: '', currencyCode: 'CVE' };
  for (const r of rows) {
    if (r.key === 'companyName' && r.value) out.companyName = r.value;
    else if (r.key === 'nif') out.nif = r.value || '';
    else if (r.key === 'currencyCode' && r.value) out.currencyCode = r.value;
  }
  return out;
}

function loadReportData() {
  const db = getSqliteDatabase();
  const opexCtx = loadCompanyOpexContext();

  const rows = db.prepare(`
    SELECT
      i.id, i.name, i.type, i.zone,
      c.full_name AS clientName,
      i.status,
      i.investment_date AS investmentDate,
      i.total_cost_cve AS totalCostCve,
      i.installed_clients AS installedClients,
      i.target_clients AS targetClients,
      i.expected_monthly_revenue_cve AS expectedMonthlyRevenueCve,
      i.monthly_operational_cost_cve AS monthlyOperationalCostCve,
      i.accumulated_revenue_cve AS accumulatedRevenueCve,
      i.desired_payback_months AS desiredPaybackMonths,
      i.client_id AS clientId
    FROM investments i
    LEFT JOIN clients c ON c.id = i.client_id
    ORDER BY i.investment_date DESC, i.id DESC
  `).all() as Array<ReportInvestmentRow & { monthlyOperationalCostCve: number; accumulatedRevenueCve: number; desiredPaybackMonths: number; clientId: number | null }>;

  const investments: ReportInvestmentRow[] = rows.map((row) => {
    const imputed = opexCtx.opexPerClientPerMonth * (Number(row.installedClients) || 0);
    const directInv = opexCtx.directByInvestment[row.id] || 0;
    const directZone = row.zone ? (opexCtx.directByZone[row.zone] || 0) : 0;
    const directClient = row.clientId != null ? (opexCtx.directByClient[row.clientId] || 0) : 0;
    const direct = directInv + directZone + directClient;
    const effective = (Number(row.monthlyOperationalCostCve) || 0) + imputed + direct;
    const revenue = Number(row.expectedMonthlyRevenueCve) || 0;
    const net = revenue - effective;
    const accumulated = (Number(row.accumulatedRevenueCve) || 0) - (Number(row.totalCostCve) || 0);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      zone: row.zone,
      clientName: row.clientName,
      status: row.status,
      investmentDate: row.investmentDate,
      totalCostCve: Number(row.totalCostCve) || 0,
      installedClients: row.installedClients,
      targetClients: row.targetClients,
      expectedMonthlyRevenueCve: revenue,
      imputedMonthlyOpexCve: imputed,
      directAllocatedOpexCve: direct,
      effectiveMonthlyOpexCve: effective,
      actualMonthlyRevenueCve: null,
      monthlyNetProfitCve: net,
      recoveryMonths: net > 0 ? row.totalCostCve / net : null,
      roiPct: row.totalCostCve > 0 ? (accumulated / row.totalCostCve) * 100 : null,
      isRecovered: accumulated >= 0 ? 1 : 0
    };
  });

  const expenses = db.prepare(`
    SELECT
      e.id, e.expense_date AS expenseDate, e.reference_month AS referenceMonth,
      e.category, e.description, e.supplier, e.amount_cve AS amountCve,
      i.name AS investmentName, e.zone, c.full_name AS clientName
    FROM expenses e
    LEFT JOIN investments i ON i.id = e.investment_id
    LEFT JOIN clients c ON c.id = e.client_id
    ORDER BY e.expense_date DESC, e.id DESC
  `).all() as ReportExpenseRow[];

  const totals = {
    totalCostCve: investments.reduce((s, r) => s + r.totalCostCve, 0),
    monthlyNetProfitCve: investments.reduce((s, r) => s + r.monthlyNetProfitCve, 0),
    avgMonthlyOpex: opexCtx.avgMonthlyOpex,
    avgRoiPct: investments.length
      ? investments.filter((r) => r.roiPct !== null).reduce((s, r) => s + (r.roiPct || 0), 0) / Math.max(1, investments.filter((r) => r.roiPct !== null).length)
      : 0
  };

  return { investments, expenses, totals, opexCtx };
}

function formatCve(value: number, currency = 'CVE'): string {
  return `${Math.round(value).toLocaleString('pt-PT')} ${currency}`;
}

export async function buildProfitabilityPdf(): Promise<Buffer> {
  const company = loadCompany();
  const data = loadReportData();
  const today = new Date().toISOString().slice(0, 10);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const M = 40;
    const CW = W - M * 2;

    doc.font('Helvetica-Bold').fontSize(7).fillColor('#6b6258')
      .text('RELATORIO DE RENTABILIDADE', M, M, { width: CW, characterSpacing: 1.8 });
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1714')
      .text(company.companyName, M, M + 12);
    doc.font('Helvetica').fontSize(9).fillColor('#6b6258')
      .text(`${company.nif ? `NIF ${company.nif} · ` : ''}Gerado em ${today}`, M, M + 36);

    let y = M + 64;
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#e1d6c0').lineWidth(0.5).stroke();
    y += 18;

    // KPI strip
    const kpis: Array<{ label: string; value: string }> = [
      { label: 'Total investido', value: formatCve(data.totals.totalCostCve, company.currencyCode) },
      { label: 'OPEX médio / mês', value: formatCve(data.totals.avgMonthlyOpex, company.currencyCode) },
      { label: 'Lucro mensal', value: formatCve(data.totals.monthlyNetProfitCve, company.currencyCode) },
      { label: 'ROI médio', value: data.totals.avgRoiPct ? `${data.totals.avgRoiPct.toFixed(1)}%` : '-' }
    ];
    const colW = CW / kpis.length;
    kpis.forEach((kpi, i) => {
      const x = M + colW * i;
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#6b6258')
        .text(kpi.label.toUpperCase(), x, y, { width: colW - 8, characterSpacing: 1 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1714')
        .text(kpi.value, x, y + 10, { width: colW - 8 });
    });
    y += 44;
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#e1d6c0').lineWidth(0.5).stroke();
    y += 14;

    // Top investments table
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b6258')
      .text('TOP INVESTIMENTOS POR CUSTO', M, y, { characterSpacing: 1.2 });
    y += 14;
    const headers = ['Nome', 'Zona', 'Investido', 'Lucro/mes', 'ROI', 'Recuperacao'];
    const cols = [0.32, 0.18, 0.14, 0.14, 0.10, 0.12];
    let x = M;
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#6b6258');
    headers.forEach((h, i) => {
      doc.text(h.toUpperCase(), x, y, { width: CW * cols[i] - 6, characterSpacing: 0.6 });
      x += CW * cols[i];
    });
    y += 10;
    doc.moveTo(M, y).lineTo(W - M, y).strokeColor('#e1d6c0').lineWidth(0.3).stroke();
    y += 4;

    const top = [...data.investments].sort((a, b) => b.totalCostCve - a.totalCostCve).slice(0, 12);
    for (const inv of top) {
      if (y > doc.page.height - 80) { doc.addPage(); y = M; }
      x = M;
      const recovery = inv.recoveryMonths !== null ? `${inv.recoveryMonths.toFixed(0)} m` : '-';
      const roi = inv.roiPct !== null ? `${inv.roiPct.toFixed(1)}%` : '-';
      const cells = [
        inv.name,
        inv.zone || (inv.clientName ? inv.clientName : '-'),
        formatCve(inv.totalCostCve, ''),
        formatCve(inv.monthlyNetProfitCve, ''),
        roi,
        recovery
      ];
      const colour = inv.monthlyNetProfitCve < 0 ? '#c64a3f' : '#1a1714';
      doc.font('Helvetica').fontSize(8.5).fillColor(colour);
      cells.forEach((c, i) => {
        doc.text(c, x, y, { width: CW * cols[i] - 6, lineBreak: false, ellipsis: true });
        x += CW * cols[i];
      });
      y += 14;
    }

    // Footer
    const footerY = doc.page.height - 30;
    doc.moveTo(M, footerY).lineTo(W - M, footerY).strokeColor('#e1d6c0').lineWidth(0.4).stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#6b6258')
      .text(
        `${data.investments.length} investimentos · ${data.expenses.length} despesas · OPEX rateio ${formatCve(data.opexCtx.opexPerClientPerMonth, company.currencyCode)}/cliente`,
        M, footerY + 4, { width: CW, align: 'center', lineBreak: false }
      );

    doc.end();
  });
}

export async function buildProfitabilityXlsx(): Promise<Buffer> {
  const company = loadCompany();
  const data = loadReportData();
  const wb = new ExcelJS.Workbook();
  wb.creator = company.companyName;
  wb.created = new Date();

  const sum = wb.addWorksheet('Sumário');
  sum.columns = [
    { header: 'Indicador', key: 'label', width: 30 },
    { header: 'Valor', key: 'value', width: 24, style: { numFmt: '#,##0' } }
  ];
  sum.addRow({ label: 'Empresa', value: company.companyName });
  sum.addRow({ label: 'NIF', value: company.nif || '-' });
  sum.addRow({ label: 'Total investido (CVE)', value: data.totals.totalCostCve });
  sum.addRow({ label: 'OPEX médio mensal (CVE)', value: data.totals.avgMonthlyOpex });
  sum.addRow({ label: 'Lucro mensal agregado (CVE)', value: data.totals.monthlyNetProfitCve });
  sum.addRow({ label: 'ROI médio (%)', value: data.totals.avgRoiPct });
  sum.addRow({ label: 'OPEX por cliente / mês (CVE)', value: data.opexCtx.opexPerClientPerMonth });
  sum.addRow({ label: 'Clientes instalados activos', value: data.opexCtx.totalInstalledActive });
  sum.getRow(1).font = { bold: true };

  const inv = wb.addWorksheet('Investimentos');
  inv.columns = [
    { header: 'Id', key: 'id', width: 6 },
    { header: 'Nome', key: 'name', width: 30 },
    { header: 'Tipo', key: 'type', width: 14 },
    { header: 'Zona', key: 'zone', width: 16 },
    { header: 'Cliente', key: 'clientName', width: 22 },
    { header: 'Estado', key: 'status', width: 12 },
    { header: 'Data', key: 'investmentDate', width: 12 },
    { header: 'Investido', key: 'totalCostCve', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Instalados', key: 'installedClients', width: 10 },
    { header: 'Alvo', key: 'targetClients', width: 8 },
    { header: 'Receita esperada/mês', key: 'expectedMonthlyRevenueCve', width: 18, style: { numFmt: '#,##0' } },
    { header: 'OPEX rateio/mês', key: 'imputedMonthlyOpexCve', width: 15, style: { numFmt: '#,##0' } },
    { header: 'OPEX directo/mês', key: 'directAllocatedOpexCve', width: 15, style: { numFmt: '#,##0' } },
    { header: 'OPEX efectivo/mês', key: 'effectiveMonthlyOpexCve', width: 17, style: { numFmt: '#,##0' } },
    { header: 'Lucro/mês', key: 'monthlyNetProfitCve', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Recuperação (meses)', key: 'recoveryMonths', width: 18, style: { numFmt: '0.0' } },
    { header: 'ROI %', key: 'roiPct', width: 10, style: { numFmt: '0.0' } },
    { header: 'Recuperado', key: 'isRecovered', width: 12 }
  ];
  inv.getRow(1).font = { bold: true };
  data.investments.forEach((row) => inv.addRow(row));

  const exp = wb.addWorksheet('Despesas');
  exp.columns = [
    { header: 'Id', key: 'id', width: 6 },
    { header: 'Data', key: 'expenseDate', width: 12 },
    { header: 'Mês ref.', key: 'referenceMonth', width: 10 },
    { header: 'Categoria', key: 'category', width: 16 },
    { header: 'Descrição', key: 'description', width: 32 },
    { header: 'Fornecedor', key: 'supplier', width: 22 },
    { header: 'Valor', key: 'amountCve', width: 14, style: { numFmt: '#,##0' } },
    { header: 'Investimento', key: 'investmentName', width: 26 },
    { header: 'Zona', key: 'zone', width: 14 },
    { header: 'Cliente', key: 'clientName', width: 22 }
  ];
  exp.getRow(1).font = { bold: true };
  data.expenses.forEach((row) => exp.addRow(row));

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

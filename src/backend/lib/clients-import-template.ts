import ExcelJS from 'exceljs';

type Column = {
  key: string;
  header: string;
  width: number;
  example1: string;
  example2: string;
};

const COLUMNS: Column[] = [
  { key: 'codigo', header: 'Código', width: 14, example1: 'CLT-0001', example2: '' },
  { key: 'nif', header: 'NIF', width: 14, example1: '100200300', example2: '234567890' },
  { key: 'nome', header: 'Nome', width: 28, example1: 'Maria Silva Tavares', example2: 'João Mendes Lima' },
  { key: 'telefone', header: 'Telefone', width: 14, example1: '9911223', example2: '9933445' },
  { key: 'email', header: 'Email', width: 28, example1: 'maria.tavares@exemplo.cv', example2: '' },
  { key: 'morada', header: 'Morada', width: 32, example1: 'Rua do Mar, 12', example2: 'Avenida Amílcar Cabral, 5' },
  { key: 'ilha', header: 'Ilha', width: 14, example1: 'Santiago', example2: 'São Vicente' },
  { key: 'zona', header: 'Zona', width: 18, example1: 'Praia — Achada', example2: 'Mindelo — Centro' }
];

const HEADER_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E293B' }
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  name: 'Inter',
  size: 11,
  bold: true,
  color: { argb: 'FFE2E8F0' }
};

const HEADER_BORDER: Partial<ExcelJS.Borders> = {
  bottom: { style: 'medium', color: { argb: 'FFFFA500' } }
};

const CELL_FONT: Partial<ExcelJS.Font> = { name: 'Inter', size: 11 };

const INSTRUCTION_TITLE_FONT: Partial<ExcelJS.Font> = { name: 'Inter', size: 13, bold: true };
const INSTRUCTION_FIELD_FONT: Partial<ExcelJS.Font> = { name: 'Inter', size: 11, bold: true };
const INSTRUCTION_BODY_FONT: Partial<ExcelJS.Font> = { name: 'Inter', size: 11, color: { argb: 'FF334155' } };

const INSTRUCTIONS: { field: string; required: string; rule: string }[] = [
  { field: 'Código', required: 'opcional', rule: 'Se vazio, o sistema gera (CLT-NNNN).' },
  { field: 'NIF', required: 'opcional', rule: '9 dígitos numéricos. Duplicados são ignorados.' },
  { field: 'Nome', required: 'obrigatório', rule: 'Nome completo do cliente.' },
  { field: 'Telefone', required: 'opcional', rule: 'Número de contacto. Duplicados são ignorados.' },
  { field: 'Email', required: 'opcional', rule: 'Validado no formato nome@dominio.tld.' },
  { field: 'Morada', required: 'opcional', rule: 'Endereço livre.' },
  { field: 'Ilha', required: 'opcional', rule: 'Ex.: Santiago, São Vicente, Sal.' },
  { field: 'Zona', required: 'opcional', rule: 'Bairro ou localidade.' }
];

export async function buildClientsImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ISPM';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Clientes', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = COLUMNS.map((column) => ({
    key: column.key,
    header: column.header,
    width: column.width
  }));

  const header = sheet.getRow(1);
  header.height = 22;
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  header.border = HEADER_BORDER;

  const example1 = sheet.addRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.example1])));
  const example2 = sheet.addRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.example2])));
  for (const row of [example1, example2]) {
    row.font = CELL_FONT;
    row.alignment = { vertical: 'middle', indent: 1 };
    row.height = 20;
  }

  const instructions = wb.addWorksheet('Instruções', { views: [{ state: 'frozen', ySplit: 2 }] });
  instructions.columns = [
    { header: 'Campo', width: 16 },
    { header: 'Obrigatório?', width: 16 },
    { header: 'Regra', width: 64 }
  ];

  const title = instructions.getRow(1);
  title.values = ['Como preencher o template', '', ''];
  title.font = INSTRUCTION_TITLE_FONT;
  title.height = 24;
  instructions.mergeCells('A1:C1');

  const headerRow = instructions.getRow(2);
  headerRow.values = ['Campo', 'Obrigatório?', 'Regra'];
  headerRow.font = HEADER_FONT;
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', indent: 1 };
  headerRow.border = HEADER_BORDER;
  headerRow.height = 22;

  INSTRUCTIONS.forEach((rule) => {
    const row = instructions.addRow([rule.field, rule.required, rule.rule]);
    row.getCell(1).font = INSTRUCTION_FIELD_FONT;
    row.getCell(2).font = INSTRUCTION_BODY_FONT;
    row.getCell(3).font = INSTRUCTION_BODY_FONT;
    row.alignment = { vertical: 'middle', indent: 1, wrapText: true };
  });

  const notesStart = instructions.lastRow!.number + 2;
  const notes = [
    'A primeira linha contém os cabeçalhos — não a apagues nem alteres os nomes.',
    'Linhas duplicadas (mesmo código, NIF ou telefone) são ignoradas automaticamente.',
    'Linhas sem nome são marcadas como erro e não são importadas.',
    'Podes apagar as linhas de exemplo antes de enviares.'
  ];
  notes.forEach((text, index) => {
    const row = instructions.getRow(notesStart + index);
    row.values = [text];
    row.font = INSTRUCTION_BODY_FONT;
    instructions.mergeCells(`A${row.number}:C${row.number}`);
    row.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    row.height = 22;
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

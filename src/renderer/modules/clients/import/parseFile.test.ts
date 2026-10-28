/** @vitest-environment jsdom */
import ExcelJS from 'exceljs';
import { expect, test } from 'vitest';
import { parseFile } from './parseFile';

test('lê a primeira folha de um XLSX real com a API instalada, sem tratar folhas como linhas', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Equipamentos');
  sheet.addRow(['ID', 'Código', 'Gama LAN']);
  sheet.addRow([12, 'CL-001', '192.168.9.15/24']);
  workbook.addWorksheet('Instruções').addRow(['Não importar esta folha']);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const file = new File([bytes], 'equipamentos.xlsx');
  // jsdom ainda não fornece Blob.arrayBuffer; os bytes são do XLSX real acima.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  await expect(parseFile(file)).resolves.toEqual({
    headers: ['ID', 'Código', 'Gama LAN'], rows: [{ ID: '12', Código: 'CL-001', 'Gama LAN': '192.168.9.15/24' }]
  });
});

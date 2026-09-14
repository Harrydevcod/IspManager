import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Catraca: toda a coluna de dados de uma lista ordena-se pelo cabeçalho.
 *
 * Conta, em cada ficheiro de módulo que desenha uma `DataTable`, as colunas
 * (`header:`) e os `sortValue:`. Uma coluna nova sem `sortValue` desequilibra a
 * conta e parte aqui — foi assim que Serviços, Planos, Despesas e Investimentos
 * ficaram sem ordenação nenhuma.
 */

const MODULES_DIR = __dirname;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

const tables = tsxFiles(MODULES_DIR)
  .map((path) => ({ file: relative(MODULES_DIR, path).replaceAll('\\', '/'), source: readFileSync(path, 'utf8') }))
  .filter(({ source }) => /\bheader:/.test(source) && /DataTable/.test(source));

describe('colunas ordenáveis', () => {
  test('encontra as listas conhecidas', () => {
    expect(tables.map((t) => t.file).sort()).toEqual([
      'ClientsModule.tsx',
      'ExpensesModule.tsx',
      'InvestmentsModule.tsx',
      'PlansModule.tsx',
      'ReceivablesModule.tsx',
      'ServicesModule.tsx',
      'StockModule.tsx',
      'finance/PortfolioTable.tsx',
      'payments/PaymentsList.tsx',
      'topology/discovery/DiscoveryWorkspace.tsx'
    ]);
  });

  test.each(tables)('$file: cada coluna tem sortValue', ({ source }) => {
    const headers = source.match(/\bheader:/g)?.length ?? 0;
    const sortable = source.match(/\bsortValue:/g)?.length ?? 0;
    expect(sortable).toBe(headers);
  });
});

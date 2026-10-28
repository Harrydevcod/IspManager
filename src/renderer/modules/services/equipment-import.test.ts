import { describe, expect, test } from 'vitest';
import Papa from 'papaparse';
import { buildEquipmentPreview, equipmentTemplate, type EquipmentAssignment } from './equipment-import';

const equipment: EquipmentAssignment[] = [
  { id: 11, clientCode: 'CL-001', clientName: 'Ana', brand: 'Acme', model: 'CPE', macAddress: 'AA:BB:CC:DD:EE:01', ipAddress: '10.0.0.1', wanMode: 'dhcp', operationMode: 'ponte', lanCidr: null },
  { id: 12, clientCode: 'CL-001', clientName: 'Ana', brand: null, model: 'Router', macAddress: 'AA:BB:CC:DD:EE:02', ipAddress: '10.0.0.2', wanMode: 'dhcp', operationMode: 'router', lanCidr: '192.168.1.0/24' }
];

describe('importação de equipamentos', () => {
  test('o modelo exportado volta sem alterações e mantém os IDs de cada equipamento do cliente', () => {
    const parsed = Papa.parse<Record<string, string>>(equipmentTemplate(equipment), { header: true });
    const preview = buildEquipmentPreview(parsed.data, parsed.meta.fields ?? [], equipment);
    expect(preview.map((row) => [row.id, row.errors, row.changes])).toEqual([[11, [], []], [12, [], []]]);
  });

  test('casa por ID, confere o código e recusa IDs desconhecidos sem aplicar', () => {
    const preview = buildEquipmentPreview([
      { ID: '12', Código: 'CL-001', MAC: 'aabb.ccdd.eeff', 'Gama LAN': '192.168.9.15/24' },
      { ID: '11', Código: 'CL-999', MAC: 'AA:BB:CC:DD:EE:09' },
      { ID: '999', Código: 'CL-001', MAC: '' }
    ], ['ID', 'Código', 'MAC', 'Gama LAN'], equipment);
    expect(preview[0].patch).toEqual({ id: 12, macAddress: 'AA:BB:CC:DD:EE:FF', lanCidr: '192.168.9.0/24' });
    expect(preview[0].changes).toHaveLength(2);
    expect(preview[1].errors.join(' ')).toMatch(/código/i);
    expect(preview[2].errors.join(' ')).toMatch(/desconhecido/i);
    expect(preview.slice(1).every((row) => row.patch === null)).toBe(true);
  });

  test('coluna ausente preserva e célula vazia limpa explicitamente', () => {
    const [row] = buildEquipmentPreview([{ id: '12', clientCode: 'CL-001', lanCidr: '' }], ['id', 'clientCode', 'lanCidr'], equipment);
    expect(row.patch).toEqual({ id: 12, lanCidr: null });
    expect(row.changes).toEqual([{ field: 'lanCidr', before: '192.168.1.0/24', after: null }]);
  });

  test.each([
    ['MAC', 'não é mac'], ['IP', '10.0.0.999'], ['Modo WAN', 'magia'],
    ['Modo de operação', 'desconhecido'], ['Gama LAN', '192.168.0.1/33']
  ])('recusa %s inválido', (column, value) => {
    const [row] = buildEquipmentPreview([{ ID: '11', Código: 'CL-001', [column]: value }], ['ID', 'Código', column], equipment);
    expect(row.errors.length).toBeGreaterThan(0);
    expect(row.patch).toBeNull();
  });

  test('recusa todas as linhas com ID repetido', () => {
    const preview = buildEquipmentPreview([
      { ID: '11', Código: 'CL-001', IP: '10.0.0.5' }, { ID: '11', Código: 'CL-001', IP: '10.0.0.6' }
    ], ['ID', 'Código', 'IP'], equipment);
    expect(preview).toHaveLength(2);
    expect(preview.every((row) => row.errors.some((error) => /ID.*repetido/i.test(error)) && row.patch === null)).toBe(true);
  });

  test.each(['MAC', 'IP'])('recusa ambas as linhas quando o %s se repete no ficheiro', (column) => {
    const value = column === 'MAC' ? 'AA:BB:CC:DD:EE:09' : '10.0.0.9';
    const preview = buildEquipmentPreview([
      { ID: '11', Código: 'CL-001', [column]: value }, { ID: '12', Código: 'CL-001', [column]: value }
    ], ['ID', 'Código', column], equipment);
    expect(preview).toHaveLength(2);
    expect(preview.every((row) => row.errors.some((error) => /repetido/i.test(error)) && row.patch === null)).toBe(true);
  });

  test('permite trocar IPs entre equipamentos sem colisão na pré-visualização', () => {
    const preview = buildEquipmentPreview([
      { ID: '11', Código: 'CL-001', IP: '10.0.0.2' }, { ID: '12', Código: 'CL-001', IP: '10.0.0.1' }
    ], ['ID', 'Código', 'IP'], equipment);
    expect(preview.map((row) => row.patch)).toEqual([{ id: 11, ipAddress: '10.0.0.2' }, { id: 12, ipAddress: '10.0.0.1' }]);
  });

  test('exige ID, código e pelo menos uma coluna editável', () => {
    expect(() => buildEquipmentPreview([], ['ID', 'MAC'], equipment)).toThrow(/código/i);
    expect(() => buildEquipmentPreview([], ['Código', 'MAC'], equipment)).toThrow(/ID/i);
    expect(() => buildEquipmentPreview([], ['ID', 'Código'], equipment)).toThrow(/coluna/i);
  });

  test('um modo histórico livre volta sem se tornar um patch recusado pelo servidor', () => {
    const current = [{ ...equipment[0], operationMode: 'Bridge manual' }];
    const [row] = buildEquipmentPreview([{ ID: '11', Código: 'CL-001', 'Modo de operação': 'Bridge manual', IP: '10.0.0.8' }], ['ID', 'Código', 'Modo de operação', 'IP'], current);
    expect(row.errors).toEqual([]);
    expect(row.patch).toEqual({ id: 11, ipAddress: '10.0.0.8' });
  });

  test('o modelo protege fórmulas e reconhece o escape apenas para o código real da atribuição', () => {
    const current = [{ ...equipment[0], clientCode: '+001' }];
    const csv = equipmentTemplate(current);
    expect(csv).toContain("'+001");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true });
    expect(buildEquipmentPreview(parsed.data, parsed.meta.fields ?? [], current)[0].errors).toEqual([]);
    const [wrong] = buildEquipmentPreview([{ ID: '11', Código: "'+002", IP: '10.0.0.8' }], ['ID', 'Código', 'IP'], current);
    expect(wrong.patch).toBeNull();
  });
});

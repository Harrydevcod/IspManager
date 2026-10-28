import Papa from 'papaparse';
import { isIpv4, parseCidr } from '../../../shared/ip-range';
import { isMacAddress, normalizeMacAddress } from '../../../shared/mac';
import { isKnownWanMode } from '../../../shared/wan';
import { isKnownOperationMode } from '../../../shared/operation';
import { detectMapping } from '../clients/import/parseFile';

export type EquipmentAssignment = {
  id: number; clientCode: string; clientName: string; brand: string | null; model: string;
  macAddress: string | null; ipAddress: string | null; wanMode: string | null;
  operationMode: string | null; lanCidr: string | null;
};
export type EquipmentField = 'macAddress' | 'ipAddress' | 'wanMode' | 'operationMode' | 'lanCidr';
export type EquipmentPatch = { id: number } & Partial<Record<EquipmentField, string | null>>;
export type EquipmentPreview = {
  line: number; id: number | null; equipment: EquipmentAssignment | null;
  errors: string[]; changes: Array<{ field: EquipmentField; before: string | null; after: string | null }>;
  patch: EquipmentPatch | null;
};
export const EQUIPMENT_LABELS: Record<EquipmentField, string> = {
  macAddress: 'MAC', ipAddress: 'IP', wanMode: 'Modo WAN', operationMode: 'Modo de operação', lanCidr: 'Gama LAN'
};
const FIELDS = Object.keys(EQUIPMENT_LABELS) as EquipmentField[];
const HINTS = {
  id: [/^(id|id da atribui[çc][ãa]o|assignment.?id)$/i],
  clientCode: [/^(c[oó]digo( do cliente)?|client.?code)$/i],
  macAddress: [/^(mac|mac.?address)$/i],
  ipAddress: [/^(ip|ip.?address)$/i],
  wanMode: [/^(modo wan|wan.?mode)$/i],
  operationMode: [/^(modo de opera[çc][ãa]o|operation.?mode)$/i],
  lanCidr: [/^(gama lan|lan.?cidr)$/i]
};

/** O ID distingue as várias unidades do mesmo cliente; o código confere a associação. */
export function equipmentTemplate(rows: EquipmentAssignment[]): string {
  return '\uFEFF' + Papa.unparse(rows.map((row) => ({
    ID: row.id, Código: row.clientCode, Cliente: row.clientName,
    Equipamento: [row.brand, row.model].filter(Boolean).join(' '),
    MAC: row.macAddress ?? '', IP: row.ipAddress ?? '',
    'Modo WAN': row.wanMode ?? '', 'Modo de operação': row.operationMode ?? '', 'Gama LAN': row.lanCidr ?? ''
  })), { delimiter: ';', escapeFormulae: true });
}

/** Só devolve patches para linhas válidas e alteradas; não altera os dados recebidos. */
export function buildEquipmentPreview(rows: Record<string, string>[], headers: string[], equipment: EquipmentAssignment[]): EquipmentPreview[] {
  const mapping = detectMapping(headers, HINTS);
  if (!mapping.id) throw new Error('Falta a coluna ID da atribuição. Descarregue o modelo.');
  if (!mapping.clientCode) throw new Error('Falta a coluna Código do cliente. Descarregue o modelo.');
  if (!FIELDS.some((field) => mapping[field])) throw new Error('Inclua pelo menos uma coluna a alterar: MAC, IP, modo WAN, modo de operação ou gama LAN.');
  for (const hints of Object.values(HINTS)) {
    if (headers.filter((header) => hints.some((hint) => hint.test(header.trim()))).length > 1) {
      throw new Error('Há colunas repetidas para o mesmo dado. Use apenas uma coluna por dado.');
    }
  }
  const byId = new Map(equipment.map((row) => [row.id, row]));
  const preview = rows.map((raw, index): EquipmentPreview => {
    const idText = String(raw[mapping.id] ?? '').trim();
    const id = /^[1-9]\d*$/.test(idText) && Number.isSafeInteger(Number(idText)) ? Number(idText) : null;
    const current = id === null ? null : byId.get(id) ?? null;
    const errors: string[] = [];
    const changes: EquipmentPreview['changes'] = [];
    if (!current) errors.push('ID desconhecido ou atribuição já terminada');
    const code = String(raw[mapping.clientCode] ?? '').trim();
    if (current && code !== current.clientCode && !(/^[=+\-@\t\r]/.test(current.clientCode) && code === `'${current.clientCode}`)) errors.push('O código do cliente não corresponde a esta atribuição');
    const patch: EquipmentPatch | null = id === null ? null : { id };
    for (const field of FIELDS) {
      if (!mapping[field]) continue;
      const text = String(raw[mapping[field]] ?? '').trim();
      let value: string | null = text || null;
      if (field === 'macAddress') {
        value = normalizeMacAddress(text);
        if (value && !isMacAddress(value)) errors.push('MAC inválido');
      } else if (field === 'ipAddress') {
        if (value && !isIpv4(value)) errors.push('IP inválido');
        else if (value) value = value.split('.').map(Number).join('.');
      } else if (field === 'lanCidr') {
        if (value && !parseCidr(value)) errors.push('Gama LAN inválida');
        else if (value) value = parseCidr(value)!.canonical;
      } else if (field === 'wanMode' || field === 'operationMode') {
        value = text.toLowerCase() || null;
        const known = field === 'wanMode' ? isKnownWanMode : isKnownOperationMode;
        if (value && !known(value)) {
          if (text === current?.[field]) value = text;
          else errors.push(`${EQUIPMENT_LABELS[field]} desconhecido`);
        }
      }
      if (current && value !== (current[field] ?? null)) {
        changes.push({ field, before: current[field] ?? null, after: value });
        if (patch) patch[field] = value;
      }
    }
    return { line: index + 2, id, equipment: current, errors, changes, patch };
  });
  // Marcar ambos os lados do conflito: aceitar o primeiro esconderia uma ambiguidade.
  for (const field of ['id', 'macAddress', 'ipAddress'] as const) {
    const groups = new Map<string, EquipmentPreview[]>();
    for (const row of preview) {
      const change = field === 'id' ? null : row.changes.find((item) => item.field === field);
      const value = field === 'id' ? row.id : change ? change.after : row.equipment?.[field];
      if (value === null || value === undefined || value === '') continue;
      const key = String(value);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        for (const row of group) row.errors.push(`${field === 'id' ? 'ID' : EQUIPMENT_LABELS[field]} repetido no ficheiro`);
      }
    }
  }
  for (const row of preview) {
    if (row.errors.length || row.changes.length === 0) row.patch = null;
  }
  return preview;
}

export type TargetField =
  | 'clientCode'
  | 'nif'
  | 'fullName'
  | 'phone'
  | 'email'
  | 'address'
  | 'island'
  | 'zone';

export const TARGET_LABEL: Record<TargetField, string> = {
  clientCode: 'Código',
  nif: 'NIF',
  fullName: 'Nome',
  phone: 'Telefone',
  email: 'Email',
  address: 'Morada',
  island: 'Ilha',
  zone: 'Zona'
};

export const TARGET_HINTS: Record<TargetField, RegExp[]> = {
  clientCode: [/^(codigo|c[oó]digo|code|client[\s_-]?code|cliente[\s_-]?id|n[uú]mero|nº|n\.|numero)$/i],
  nif: [/^(nif|fiscal|tax(\s?id)?|cif)$/i],
  fullName: [/^(nome|name|cliente|fullname|full[\s_-]?name|nome[\s_-]?completo|razao[\s_-]?social)$/i],
  phone: [/^(telefone|telem[oó]vel|phone|tel|contacto|m[oó]vel|mobile|whatsapp)$/i],
  email: [/^(e?[\s_-]?mail|correio)$/i],
  address: [/^(morada|endere[cç]o|address|rua)$/i],
  island: [/^(ilha|island)$/i],
  zone: [/^(zona|bairro|zone|localidade|local)$/i]
};

export const REQUIRED: TargetField[] = ['fullName'];

export type ParsedRow = Record<string, string>;

export type ColumnMapping = Record<TargetField, string | ''>;

export const EMPTY_MAPPING: ColumnMapping = {
  clientCode: '',
  nif: '',
  fullName: '',
  phone: '',
  email: '',
  address: '',
  island: '',
  zone: ''
};

export type PreviewRow = {
  index: number;
  raw: ParsedRow;
  values: Partial<Record<TargetField, string>>;
  errors: string[];
  conflict: 'clientCode' | 'nif' | 'phone' | null;
};

export type BulkResult = {
  summary: { received: number; inserted: number; skipped: number; errors: number };
  inserted: Array<{ index: number; clientCode: string }>;
  skipped: Array<{ index: number; reason: string; value?: string }>;
  errors: Array<{ index: number; reason: string; detail?: string }>;
};

export type ExistingHints = {
  codes: Set<string>;
  nifs: Set<string>;
  phones: Set<string>;
};

export type ImportStep = 'upload' | 'preview' | 'result';

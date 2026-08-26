/**
 * Os tipos de catálogo que vêm de fábrica — sugestões, não o universo.
 *
 * O tipo é texto livre desde a migração 0047: o operador escreve o que faltar no
 * próprio formulário do Stock e a base só exige que não venha vazio. Esta lista
 * é o que se oferece primeiro no `<select>`, e é dela que saem os rótulos e as
 * duas abas do catálogo.
 *
 * Um tipo escrito à mão é só uma etiqueta. Comportamento — levar IP fixo, poder
 * ligar ao backbone — continua a sair das listas fixas mais abaixo e de
 * `BACKBONE_UPLINK_TYPES` em `topology.ts`, e essas só mudam por código.
 */
export const EQUIPMENT_TYPES = [
  'cpe',
  'router',
  'antena',
  'ap',
  'repetidor',
  'switch',
  'cabo',
  'conector',
  'ficha',
  'suporte',
  'outro'
] as const;

export type EquipmentType = typeof EQUIPMENT_TYPES[number];

/** O registo obriga a rotular um tipo novo: sem rótulo, não compila. */
export const EQUIPMENT_TYPE_LABELS: Record<EquipmentType, string> = {
  cpe: 'CPE',
  router: 'Router',
  antena: 'Antena',
  ap: 'Ponto de Acesso',
  repetidor: 'Repetidor WiFi',
  switch: 'Switch',
  cabo: 'Cabo',
  conector: 'Conector',
  ficha: 'Ficha',
  suporte: 'Suporte',
  outro: 'Outro'
};

/**
 * O rótulo de um tipo. Os predefinidos têm nome de gente no registo acima; um
 * tipo escrito à mão mostra-se à letra, tal como o operador o escreveu.
 */
export function labelForType(type: string): string {
  return EQUIPMENT_TYPE_LABELS[type as EquipmentType] ?? type;
}

/** O Stock separa o catálogo em duas abas; "outro" serve as duas. */
export const EQUIPMENT_TYPES_BY_CATEGORY: Record<
  'equipamento' | 'material',
  readonly EquipmentType[]
> = {
  equipamento: ['cpe', 'router', 'antena', 'ap', 'repetidor', 'switch', 'outro'],
  material: ['cabo', 'conector', 'ficha', 'suporte', 'outro']
};

/**
 * Só o que aponta ao backbone leva IP fixo: o CPE e a antena são o que se
 * identifica e se vai lá ver quando a ligação cai.
 *
 * Tudo o que fica atrás da antena — o router do cliente, o repetidor, o ponto de
 * acesso — apanha DHCP de quem está acima e não se registam endereços para eles.
 */
export const STATIC_IP_EQUIPMENT_TYPES: readonly EquipmentType[] = ['cpe', 'antena'];

export function takesStaticIp(catalogType: string | null | undefined): boolean {
  const normalized = (catalogType || '').trim().toLowerCase();
  return (STATIC_IP_EQUIPMENT_TYPES as readonly string[]).includes(normalized);
}

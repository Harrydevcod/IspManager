/**
 * O vocabulário de tipos do catálogo de stock, num sítio só.
 *
 * Estava escrito em quatro: o `z.enum` da rota, a união do renderer e os dois
 * `<select>` do Stock. Acrescentar um tipo obrigava a acertar os quatro à mão, e
 * bastava esquecer um para o formulário oferecer algo que a API recusa.
 *
 * O CHECK de `equipment_catalog.type` na base é a outra cópia, e essa não sai
 * daqui — vive numa migração, porque o SQLite não altera um CHECK no sítio. Um
 * tipo novo é uma linha aqui e uma migração de reconstrução (ver a 0046).
 */
export const EQUIPMENT_TYPES = [
  'cpe',
  'router',
  'antena',
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
  repetidor: 'Repetidor WiFi',
  switch: 'Switch',
  cabo: 'Cabo',
  conector: 'Conector',
  ficha: 'Ficha',
  suporte: 'Suporte',
  outro: 'Outro'
};

/** O Stock separa o catálogo em duas abas; "outro" serve as duas. */
export const EQUIPMENT_TYPES_BY_CATEGORY: Record<
  'equipamento' | 'material',
  readonly EquipmentType[]
> = {
  equipamento: ['cpe', 'router', 'antena', 'repetidor', 'switch', 'outro'],
  material: ['cabo', 'conector', 'ficha', 'suporte', 'outro']
};

/**
 * Só as antenas CPE e os pontos de acesso levam IP fixo — são o que se identifica
 * para manutenção remota. Os routers do cliente apanham IP dinâmico por DHCP e não
 * interessam para esse efeito.
 *
 * O repetidor fica de fora até alguém decidir o contrário: os que estão no terreno
 * apanham DHCP da antena a que estão ligados.
 */
export const STATIC_IP_EQUIPMENT_TYPES: readonly EquipmentType[] = ['cpe', 'antena'];

export function takesStaticIp(catalogType: string | null | undefined): boolean {
  const normalized = (catalogType || '').trim().toLowerCase();
  return (STATIC_IP_EQUIPMENT_TYPES as readonly string[]).includes(normalized);
}

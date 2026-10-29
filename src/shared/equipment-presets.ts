/**
 * Modelos de referência que a paleta da Topologia oferece para o catálogo.
 *
 * Nada disto entra na base sozinho: só nasce uma linha de `equipment_catalog`
 * quando o operador carrega em "Adicionar ao catálogo". O tipo segue os valores
 * que o catálogo já usa (`router`, `switch`, `cpe`, `antena`, `ap`) — o mapa liga
 * clientes por `cpe`/`antena` (BACKBONE_UPLINK_TYPES).
 */
export type EquipmentPreset = { brand: string; model: string; type: string };

export const EQUIPMENT_PRESETS: readonly EquipmentPreset[] = [
  { brand: 'MikroTik', model: 'hEX S', type: 'router' },
  { brand: 'MikroTik', model: 'hAP ac lite', type: 'router' },
  { brand: 'MikroTik', model: 'hAP ax S', type: 'router' },
  { brand: 'MikroTik', model: 'CCR2004-16G-2S+', type: 'router' },
  { brand: 'MikroTik', model: 'CRS326-24G-2S+', type: 'switch' },
  { brand: 'TP-Link', model: 'CPE510', type: 'cpe' },
  { brand: 'TP-Link', model: 'CPE710', type: 'cpe' },
  { brand: 'TP-Link', model: 'EAP225-Outdoor', type: 'ap' },
  { brand: 'TP-Link', model: 'TL-SG108', type: 'switch' },
  { brand: 'Ubiquiti', model: 'LiteBeam 5AC Gen2', type: 'cpe' },
  { brand: 'Ubiquiti', model: 'NanoStation AC Loco', type: 'cpe' },
  { brand: 'Ubiquiti', model: 'PowerBeam 5AC Gen2', type: 'antena' },
  { brand: 'Ubiquiti', model: 'Rocket 5AC Prism', type: 'antena' },
  { brand: 'Ubiquiti', model: 'UniFi U6 Lite', type: 'ap' },
  { brand: 'Starlink', model: 'Standard', type: 'antena' },
  { brand: 'Starlink', model: 'Mini', type: 'antena' },
  { brand: 'Starlink', model: 'Router Gen3', type: 'router' }
];

const normalize = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Já está no catálogo? Compara marca + modelo sem espaços nem pontuação, e aceita
 * o modelo do catálogo que contém o da referência ("RB760iGS hEX S" ⊇ "hEX S").
 */
export function presetInCatalog(
  preset: EquipmentPreset,
  catalog: ReadonlyArray<{ brand: string | null; model: string }>
): boolean {
  const model = normalize(preset.model);
  const brand = normalize(preset.brand);
  return catalog.some((item) => normalize(item.brand) === brand && normalize(item.model).includes(model));
}

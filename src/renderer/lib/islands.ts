/** Ilhas habitadas de Cabo Verde, ordem Barlavento→Sotavento. Lista fechada
 *  para evitar grafias divergentes ("S. Vicente", "sao vicente") nos dados. */
export const CV_ISLANDS = [
  'Santo Antão',
  'São Vicente',
  'São Nicolau',
  'Sal',
  'Boa Vista',
  'Maio',
  'Santiago',
  'Fogo',
  'Brava'
] as const;

/** Operação atual é só em São Vicente — vem pré-selecionada em registos novos. */
export const DEFAULT_ISLAND = 'São Vicente';

export function isKnownIsland(value: string): boolean {
  return (CV_ISLANDS as readonly string[]).includes(value);
}

/** Minúsculas, sem acentos, pontos e "ilha de/do/da" fora, espaços colapsados. */
function islandKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^ilha (de|do|da) /, '');
}

/**
 * As grafias que aparecem em folhas de cálculo e listas antigas, todas a
 * apontar para a oficial: sem acentos ("Sao Vicente"), abreviada ("S. Vicente",
 * "S. Antão") e sem espaços ("Boavista").
 */
const ISLAND_BY_KEY = new Map<string, string>(
  CV_ISLANDS.flatMap((island) => {
    const key = islandKey(island);
    return [
      [key, island],
      [key.replace(/^(sao|santo) /, 's '), island],
      [key.replace(/ /g, ''), island]
    ] as Array<[string, string]>;
  })
);

/** A grafia oficial da ilha, ou `null` quando não se reconhece o que veio. */
export function canonicalIsland(value: string): string | null {
  return ISLAND_BY_KEY.get(islandKey(value)) ?? null;
}

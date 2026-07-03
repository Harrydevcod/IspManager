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

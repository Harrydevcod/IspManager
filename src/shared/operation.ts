/**
 * O papel que um equipamento desempenha na rede — o que ele *faz*, por oposição
 * ao tipo de catálogo, que diz o que ele *é*.
 *
 * O mesmo TL-WR850N pode estar a encaminhar em casa de um cliente e a servir de
 * ponto de acesso em casa do vizinho. O aparelho é o mesmo; o papel não, e até
 * aqui essa diferença só existia no nome do modelo, escrito à mão: há
 * `NanoStation AC Loco Ponto de Acesso PoE` registado como `antena` e
 * `CPE 510 Ponto de Acesso para Exterior` registado como `cpe`.
 *
 * Texto livre, como o tipo desde a 0047 e o modo de ligação desde a 0056: o
 * terreno inventa arranjos que uma lista nossa não anteciparia. Um modo escrito
 * à mão é só uma etiqueta.
 *
 * Não confundir com `wan.ts`, que responde a outra pergunta — *como é que esta
 * unidade obtém endereço*. Os dois eixos são independentes: um ponto de acesso
 * pode estar em DHCP ou em IP fixo.
 */
export const OPERATION_MODES = [
  'router',
  'ap',
  'repetidor',
  'ponte',
  'mesh'
] as const;

export type OperationMode = typeof OPERATION_MODES[number];

/** O registo obriga a rotular um modo novo: sem rótulo, não compila. */
export const OPERATION_MODE_LABELS: Record<OperationMode, string> = {
  router: 'Router (Roteador)',
  ap: 'Ponto de Acesso (AP)',
  repetidor: 'Repetidor (Range Extender)',
  // O eixo vai no rótulo de propósito: há um `bridge` no modo de ligação que
  // quer dizer outra coisa (não ter endereço próprio), e sem isto trocavam-se.
  ponte: 'Ponte (Media Bridge) — Wi-Fi para cabo',
  mesh: 'Mesh'
};

/** O mesmo em versão curta, para o chip do nó do mapa. */
export const OPERATION_MODE_SHORT: Record<OperationMode, string> = {
  router: 'Router',
  ap: 'AP',
  repetidor: 'Repetidor',
  ponte: 'Ponte',
  mesh: 'Mesh'
};

export function isKnownOperationMode(mode: string | null | undefined): mode is OperationMode {
  return (OPERATION_MODES as readonly string[]).includes((mode || '').trim().toLowerCase());
}

function canonical(mode: string | null | undefined): string {
  const normalized = (mode || '').trim().toLowerCase();
  return isKnownOperationMode(normalized) ? normalized : '';
}

/**
 * O rótulo de um modo. Os predefinidos têm nome de gente no registo acima; um
 * modo escrito à mão mostra-se à letra, tal como o operador o escreveu.
 */
export function labelForOperationMode(mode: string | null | undefined): string {
  const known = canonical(mode);
  if (known) return OPERATION_MODE_LABELS[known as OperationMode];
  return (mode || '').trim();
}

/** Versão curta, mesma regra: livre mostra-se à letra. */
export function shortLabelForOperationMode(mode: string | null | undefined): string {
  const known = canonical(mode);
  if (known) return OPERATION_MODE_SHORT[known as OperationMode];
  return (mode || '').trim();
}

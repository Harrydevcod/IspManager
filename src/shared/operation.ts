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
  'cliente',
  'wisp',
  'repetidor',
  'ponte',
  'mesh'
] as const;

export type OperationMode = typeof OPERATION_MODES[number];

/** O registo obriga a rotular um modo novo: sem rótulo, não compila. */
export const OPERATION_MODE_LABELS: Record<OperationMode, string> = {
  router: 'Router',
  ap: 'Ponto de Acesso (AP)',
  // O outro lado do AP: a CPE/antena que se liga a um AP e serve o cliente.
  // A TP-Link (Pharos) chama-lhe `Client`; a Ubiquiti, `Station`.
  cliente: 'Cliente (Client / Station)',
  // Variação do Cliente: em vez de entregar o sinal ao router do cliente, a
  // própria CPE cria a rede local (NAT). O rótulo tem de dizer isto, senão
  // não se distingue do `cliente` no momento de escolher.
  wisp: 'WISP (Cliente + Router/NAT)',
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
  cliente: 'Cliente',
  wisp: 'WISP',
  repetidor: 'Repetidor',
  ponte: 'Ponte',
  mesh: 'Mesh'
};

/**
 * O que se oferece a uma CPE/antena: os sete, começados pelos que são dela.
 *
 * Uma CPE capta o sinal da torre e entrega-o por cabo — `cliente` é o modo do
 * dia-a-dia, e o `wisp` é esse mesmo com router por dentro. O firmware atual
 * dá-lhe também `router` e `mesh`, por isso não se lhe tira nada: muda a ordem,
 * para o primeiro da lista ser o que ela é quase sempre.
 */
export const CPE_OPERATION_MODES: readonly OperationMode[] = [
  'cliente',
  'ap',
  'repetidor',
  'ponte',
  'wisp',
  'router',
  'mesh'
];

/**
 * O que se oferece a todo o resto.
 *
 * `cliente` e `wisp` são modos de quem *recebe* sinal de rádio: num router de
 * casa, num switch ou num suporte não existem, e a única coisa que fazem na
 * lista é atrapalhar quem escolhe. Tirar é a diferença entre as duas listas.
 */
export const DEFAULT_OPERATION_MODES: readonly OperationMode[] = [
  'router',
  'ap',
  'repetidor',
  'ponte',
  'mesh'
];

/**
 * Que modos oferecer a um equipamento deste tipo.
 *
 * Chaveia nos mesmos dois tipos que `STATIC_IP_REQUIRED_TYPES` em
 * `equipment.ts` — é a mesma família de aparelhos, pela mesma razão. O tipo é
 * texto livre desde a 0047: o que não se reconhece cai no conjunto do resto, e
 * o formulário sem artigo escolhido também.
 *
 * Isto é ajuda de formulário, não regra de negócio: as rotas continuam a
 * aceitar qualquer etiqueta em qualquer equipamento.
 */
export function operationModesForType(
  catalogType: string | null | undefined
): readonly OperationMode[] {
  const normalized = (catalogType || '').trim().toLowerCase();
  return normalized === 'cpe' || normalized === 'antena'
    ? CPE_OPERATION_MODES
    : DEFAULT_OPERATION_MODES;
}

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

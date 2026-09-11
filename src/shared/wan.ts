/**
 * Os modos de ligação WAN que vêm de fábrica — sugestões, não o universo.
 *
 * O modo é texto livre, pela mesma razão que o tipo de equipamento o é desde a
 * migração 0047: o terreno inventa arranjos que uma lista nossa não anteciparia.
 * Esta lista é o que se oferece primeiro no `<select>`, e é dela que saem os
 * rótulos, o chip do mapa e a cor.
 *
 * Um modo escrito à mão é só uma etiqueta. Comportamento — obrigar a IP fixo,
 * pintar o chip — só sai das listas fixas aqui de baixo, e essas só mudam por
 * código.
 *
 * Nada a ver com `internet_plans.connection_type`, que é o meio físico do plano
 * (rádio, fibra, cabo). Isto é como *aquela unidade* obtém o endereço.
 *
 * Nem com `operation.ts`, que responde a outra pergunta — *que papel é que este
 * aparelho desempenha*. Os dois eixos são independentes.
 */
export const WAN_MODES = [
  'dhcp',
  'static',
  'pppoe',
  'pppoe_static',
  'bridge',
  'tunnel'
] as const;

export type WanMode = typeof WAN_MODES[number];

/** O registo obriga a rotular um modo novo: sem rótulo, não compila. */
export const WAN_MODE_LABELS: Record<WanMode, string> = {
  dhcp: 'IP dinâmico (DHCP)',
  static: 'IP estático',
  pppoe: 'PPPoE',
  pppoe_static: 'PPPoE com IP fixo',
  // O eixo vai no rótulo: ha uma 'Ponte' no modo de operacao (operation.ts) que
  // quer dizer outra coisa (converter Wi-Fi em cabo), e sem isto trocavam-se.
  bridge: 'Bridge — sem endereço próprio',
  tunnel: 'Túnel (L2TP/PPTP/WireGuard)'
};

/**
 * O mesmo modo em versão curta, para o chip do nó do mapa — onde o espaço é o
 * que sobra depois do nome do equipamento.
 */
export const WAN_MODE_SHORT: Record<WanMode, string> = {
  dhcp: 'DHCP',
  static: 'Estático',
  pppoe: 'PPPoE',
  pppoe_static: 'PPPoE+IP',
  bridge: 'Bridge',
  tunnel: 'Túnel'
};

export function isKnownWanMode(mode: string | null | undefined): mode is WanMode {
  return (WAN_MODES as readonly string[]).includes((mode || '').trim().toLowerCase());
}

function canonical(mode: string | null | undefined): string {
  const normalized = (mode || '').trim().toLowerCase();
  return isKnownWanMode(normalized) ? normalized : '';
}

/**
 * O rótulo de um modo. Os predefinidos têm nome de gente no registo acima; um
 * modo escrito à mão mostra-se à letra, tal como o operador o escreveu.
 */
export function labelForWanMode(mode: string | null | undefined): string {
  const known = canonical(mode);
  if (known) return WAN_MODE_LABELS[known as WanMode];
  return (mode || '').trim();
}

/** Versão curta, mesma regra: livre mostra-se à letra. */
export function shortLabelForWanMode(mode: string | null | undefined): string {
  const known = canonical(mode);
  if (known) return WAN_MODE_SHORT[known as WanMode];
  return (mode || '').trim();
}

/**
 * Quem não pode ficar sem endereço. `static` é óbvio; `pppoe_static` existe
 * precisamente porque alguém contratou um endereço fixo por cima da sessão — se
 * ele não estiver registado, ninguém sabe qual é.
 *
 * Os restantes recebem endereço de outra pessoa (servidor DHCP, concentrador
 * PPPoE) ou nem sequer têm um; registá-lo é opcional e serve só de referência.
 */
export const WAN_MODES_REQUIRING_IP: readonly WanMode[] = ['static', 'pppoe_static'];

export function wanModeRequiresIp(mode: string | null | undefined): boolean {
  const known = canonical(mode);
  return Boolean(known) && (WAN_MODES_REQUIRING_IP as readonly string[]).includes(known);
}

/**
 * A mesma regra para o SQL que conta atenções em bloco, para o total do mapa não
 * discordar dos nós que o mapa desenha. Literais, não parâmetros: entra no meio
 * de subconsultas já parametrizadas.
 */
export const WAN_MODES_REQUIRING_IP_SQL = WAN_MODES_REQUIRING_IP
  .map((mode) => `'${mode}'`)
  .join(', ');

/**
 * Só as antenas CPE e os pontos de acesso levam IP fixo — são o que se identifica
 * para manutenção remota. Os routers do cliente apanham IP dinâmico por DHCP e não
 * interessam para esse efeito.
 *
 * O vocabulário de tipos é fechado por CHECK na migration 0018 do catálogo
 * (`cpe, router, antena, switch, cabo, conector, ficha, suporte, outro`), por isso
 * esta lista é exaustiva: um tipo novo obriga a mexer no CHECK e passa por aqui.
 */
export const STATIC_IP_EQUIPMENT_TYPES = ['cpe', 'antena'] as const;

export function takesStaticIp(catalogType: string | null | undefined): boolean {
  const normalized = (catalogType || '').trim().toLowerCase();
  return (STATIC_IP_EQUIPMENT_TYPES as readonly string[]).includes(normalized);
}

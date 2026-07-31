const STORAGE_KEY = 'ispm-sidebar';

/** Menu recolhido no rail de ícones? Por omissão arranca expandido. */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'rail';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? 'rail' : 'expanded');
  } catch {
    /* localStorage indisponivel — preferencia nao persiste, sem impacto funcional */
  }
}

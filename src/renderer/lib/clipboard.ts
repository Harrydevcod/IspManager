/**
 * Copia texto: primeiro pela API do browser; se falhar (janela sem foco, permissão),
 * pelo clipboard do Electron através do preload. Nunca regista o valor.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      return (await window.ispm?.copyText?.(text)) === true;
    } catch {
      return false;
    }
  }
}

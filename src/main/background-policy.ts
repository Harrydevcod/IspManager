/** Never hide a window unless there is a working way to recover it. */
export function shouldHideOnClose(keepRunning: boolean, trayAvailable: boolean, quitting: boolean): boolean {
  return keepRunning && trayAvailable && !quitting;
}

export function shouldStartHidden(args: string[], trayAvailable: boolean, packaged: boolean): boolean {
  return packaged && trayAvailable && args.includes('--hidden');
}

export function parseBackgroundChange(value: unknown): { keepRunning: boolean } | { openAtLogin: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Opção inválida');
  const keys = Object.keys(value);
  if (keys.length !== 1) throw new Error('Opção inválida');
  if ('keepRunning' in value && typeof value.keepRunning === 'boolean') return { keepRunning: value.keepRunning };
  if ('openAtLogin' in value && typeof value.openAtLogin === 'boolean') return { openAtLogin: value.openAtLogin };
  throw new Error('Opção inválida');
}

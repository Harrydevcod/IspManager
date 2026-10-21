import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { DATA_COLLECTION, DROPPED_INTEGRATIONS, SENTRY_DSN, scrubBreadcrumb, scrubEvent } from '../shared/error-reports';

/**
 * A escolha vive num ficheiro do perfil e não na base: o init da Sentry tem de
 * correr antes de a janela abrir e do backend arrancar, e a base pode estar
 * trancada pelo cofre nessa altura.
 */
function settingsFile(): string {
  return path.join(app.getPath('userData'), 'error-reports.json');
}

export function readErrorReportsEnabled(): boolean {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

function writeErrorReportsEnabled(enabled: boolean): void {
  fs.writeFileSync(settingsFile(), JSON.stringify({ enabled }));
}

/** Estado com que esta sessão arrancou; a mudança só vale ao reiniciar. */
let activeThisSession = false;

/** Corre o mais cedo possível no main. Sem DSN ou sem consentimento não faz nada. */
export function initErrorReports(release: string): boolean {
  activeThisSession = Boolean(SENTRY_DSN) && readErrorReportsEnabled();
  if (!activeThisSession) return false;
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `ispm@${release}`,
    environment: app.isPackaged ? 'production' : 'development',
    dataCollection: DATA_COLLECTION,
    integrations: (defaults) => defaults.filter((integration) => !DROPPED_INTEGRATIONS.has(integration.name)),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event)
  });
  return true;
}

export function errorReportsActive(): boolean {
  return activeThisSession;
}

export function registerErrorReportsIpc(): void {
  ipcMain.handle('error-reports:get', () => ({
    available: Boolean(SENTRY_DSN),
    enabled: readErrorReportsEnabled(),
    active: activeThisSession
  }));
  ipcMain.handle('error-reports:set', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return false;
    writeErrorReportsEnabled(enabled);
    return true;
  });
}

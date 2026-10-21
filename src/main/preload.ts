import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('ispm', {
  platform: process.platform,
  // ERROR_REPORTS_ARG de src/shared/error-reports.ts; o preload em sandbox não importa módulos locais.
  errorReportsActive: process.argv.includes('--ispm-error-reports'),
  getErrorReports: (): Promise<{ available: boolean; enabled: boolean; active: boolean }> =>
    ipcRenderer.invoke('error-reports:get'),
  setErrorReports: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('error-reports:set', enabled),
  onShowReleaseNotes: (callback: (version: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, version: string) => callback(version);
    ipcRenderer.on('app:show-release-notes', listener);
    return () => {
      ipcRenderer.removeListener('app:show-release-notes', listener);
    };
  },
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  chooseBackupFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-backup-file'),
  chooseBackupDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-backup-dir'),
  openBackupDir: (dir: string): Promise<void> => ipcRenderer.invoke('backups:open-dir', dir),
  // Abre a interface web de um equipamento no browser do sistema. O esquema é
  // validado do lado do main — ver `shell:open-external`.
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:open-external', url),
  saveDocument: (
    filename: string,
    data: Uint8Array
  ): Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('documents:save', { filename, data }),
  printDocument: (
    data: Uint8Array
  ): Promise<{ printed: boolean; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('documents:print', { data })
});

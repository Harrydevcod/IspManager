import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ispm', {
  platform: process.platform,
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  chooseBackupFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-backup-file'),
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

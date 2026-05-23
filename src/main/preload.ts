import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ispm', {
  platform: process.platform,
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  chooseBackupFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:choose-backup-file')
});

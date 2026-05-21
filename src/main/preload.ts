import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('ispm', {
  platform: process.platform,
  relaunch: () => ipcRenderer.invoke('app:relaunch')
});

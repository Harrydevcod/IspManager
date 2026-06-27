import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { startBackend } from '../backend/server';

const isDevelopment = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

/**
 * Auto-update via GitHub Releases (feed em `build.publish`). Descarrega em
 * silêncio e, quando pronto, pergunta se reinicia. Só em produção — em dev o
 * electron-updater não tem `app-update.yml`. Qualquer falha (offline, sem
 * release) é registada e ignorada: nunca pode impedir o uso da app.
 */
function initAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Reiniciar agora', 'Mais tarde'],
      defaultId: 0,
      cancelId: 1,
      title: 'Atualização disponível',
      message: `ISPM ${info.version} está pronto para instalar.`,
      detail: 'A aplicação reinicia para concluir a atualização.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err instanceof Error ? err.message : err);
  });
  void autoUpdater.checkForUpdates();
}

async function createWindow() {
  const iconPath = isDevelopment
    ? path.join(__dirname, '../renderer/public/favicon.png')
    : path.join(__dirname, '../renderer/favicon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: 'ISPM',
    backgroundColor: '#16130F',
    icon: iconPath,
    webPreferences: {
      preload: isDevelopment ? undefined : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDevelopment) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  if (!isDevelopment) {
    await startBackend();
  }

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('dialog:choose-backup-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importar backup',
      properties: ['openFile'],
      filters: [
        { name: 'Backup SQLite', extensions: ['sqlite', 'db', 'bak'] },
        { name: 'Todos os ficheiros', extensions: ['*'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  await createWindow();

  if (!isDevelopment) {
    initAutoUpdater();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

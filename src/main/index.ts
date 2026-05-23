import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { startBackend } from '../backend/server';

const isDevelopment = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

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

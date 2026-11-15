import { app, ipcMain, Menu, nativeImage, Tray, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { BackgroundSettings } from '../shared/background-settings';
import { parseBackgroundChange, shouldHideOnClose, shouldStartHidden } from './background-policy';

/** Local to this computer/profile; independent of the encrypted business database. */
export function createBackgroundController(iconPath: string, getWindow: () => BrowserWindow | null) {
  const settingsPath = path.join(process.env.ISPM_DATA_DIR || app.getPath('userData'), 'background.json');
  let keepRunning = true;
  let quitting = false;
  let tray: Tray | null = null;
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof saved === 'object' && saved !== null && 'keepRunning' in saved && typeof saved.keepRunning === 'boolean') {
      keepRunning = saved.keepRunning;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[background] Preferências ilegíveis', error);
  }

  const loginOptions = { path: process.execPath, args: ['--hidden'] };
  // A preview must never register itself as the installed application at login.
  const canStartAtLogin = app.isPackaged && process.platform === 'win32' && !process.env.ISPM_DATA_DIR;

  function show() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function state(): BackgroundSettings {
    const login = canStartAtLogin ? app.getLoginItemSettings(loginOptions) : null;
    return {
      available: app.isPackaged,
      keepRunning,
      canStartAtLogin,
      openAtLogin: Boolean(login?.openAtLogin && login.executableWillLaunchAtLogin)
    };
  }

  function assertSender(event: IpcMainInvokeEvent) {
    const win = getWindow();
    if (!app.isPackaged || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error('Janela não autorizada');
    }
  }

  if (app.isPackaged) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error('Ícone da bandeja indisponível');
      tray = new Tray(icon.resize({ width: 16, height: 16 }));
      tray.setToolTip('ISPM — automatismos em segundo plano');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Abrir ISPM', click: show },
        { type: 'separator' },
        { label: 'Sair', click: () => app.quit() }
      ]));
      tray.on('double-click', show);
      tray.on('click', show);
    } catch (error) {
      tray?.destroy();
      tray = null;
      console.error('[background] Não foi possível criar a bandeja', error);
    }
  }

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { tray?.destroy(); });
  ipcMain.handle('background:get', () => state());
  ipcMain.handle('background:set', (event, value: unknown) => {
    assertSender(event);
    const change = parseBackgroundChange(value);
    if ('keepRunning' in change) {
      if (change.keepRunning && !tray) throw new Error('A bandeja não está disponível. Reinicie o ISPM.');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(`${settingsPath}.tmp`, JSON.stringify(change), { mode: 0o600 });
      fs.renameSync(`${settingsPath}.tmp`, settingsPath);
      keepRunning = change.keepRunning;
    } else {
      if (!canStartAtLogin) throw new Error('Arranque automático indisponível');
      app.setLoginItemSettings({ ...loginOptions, openAtLogin: change.openAtLogin, enabled: change.openAtLogin });
    }
    return state();
  });

  return {
    show,
    beginQuit: () => { quitting = true; },
    startHidden: () => shouldStartHidden(process.argv, tray !== null, app.isPackaged),
    attach(win: BrowserWindow) {
      // Windows can end the session without emitting app.before-quit.
      win.on('query-session-end', () => { quitting = true; });
      win.on('close', (event) => {
        if (shouldHideOnClose(keepRunning, tray !== null, quitting)) {
          event.preventDefault();
          win.hide();
        }
      });
    }
  };
}

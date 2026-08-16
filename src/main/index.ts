import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { startBackend } from '../backend/server';

const isDevelopment = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

/**
 * Uma instância só. Sem isto, abrir o atalho duas vezes deixa um processo
 * fantasma: o segundo backend rebenta com EADDRINUSE em 127.0.0.1:3001 e fica
 * uma janela em branco a mexer na mesma BD SQLite.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

/** Ícone da app (favicon.png do renderer) — janela, updater e diálogo Sobre. */
function appIconPath(): string {
  return isDevelopment
    ? path.join(__dirname, '../renderer/public/favicon.png')
    : path.join(__dirname, '../renderer/favicon.png');
}

/**
 * Versão da app fiável em dev e produção. Em dev o entry é electron/dev.cjs e o
 * Electron não encontra o package.json → app.getVersion() devolve a versão do
 * PRÓPRIO Electron (41.7.0); ler o package.json da raiz resolve.
 */
function appVersion(): string {
  if (!isDevelopment) return app.getVersion();
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return app.getVersion();
  }
}

async function showAboutDialog() {
  const options = {
    type: 'info' as const,
    buttons: ['Fechar'],
    noLink: true,
    icon: nativeImage.createFromPath(appIconPath()),
    title: 'Sobre o ISPM',
    message: `ISPM ${appVersion()}`,
    detail:
      'Gestão de operações ISP — Cabo Verde\n\n' +
      `Versão: ${appVersion()}\n` +
      `Electron: ${process.versions.electron}\n` +
      `Chromium: ${process.versions.chrome}`
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

/**
 * Novidades da versão instalada — o menu só avisa o renderer, que mostra as
 * notas num diálogo do design system (busca-as diretamente à API do GitHub,
 * só dados; o cliente nunca vê o repositório).
 */
function showReleaseNotes() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:show-release-notes', appVersion());
  }
}

/** Menu pt-PT com secção Sobre no topo — a versão fica visível sem cliques. */
function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Ficheiro',
      submenu: [{ role: 'quit', label: 'Sair' }]
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Anular' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas de programador' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom 100%' },
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Ecrã inteiro' }
      ]
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'close', label: 'Fechar' }
      ]
    },
    {
      label: 'Sobre',
      submenu: [
        { label: `ISPM ${appVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Sobre o ISPM…', click: () => void showAboutDialog() },
        { label: 'Novidades desta versão', click: () => showReleaseNotes() }
      ]
    }
  ]));
}

/**
 * Guardar documentos (faturas/recibos/relatórios PDF/CSV) com diálogo nativo
 * "Guardar como". O renderer manda os bytes já obtidos (com o header de auth) e
 * o nome informativo; aqui escolhemos o local e escrevemos.
 *
 * Substitui o antigo `will-download` sobre `blob:`: nesse fluxo o Electron
 * ignorava o nome (`getFilename()` devolvia um UUID) e o visualizador de PDF
 * embutido chegava a capturar o blob em vez de o descarregar. Passar os bytes
 * por IPC é determinista e dá ao utilizador controlo do destino.
 */
function registerDocumentSave() {
  ipcMain.handle('documents:save', async (_event, payload: { filename?: string; data?: Uint8Array }) => {
    const data = payload?.data;
    if (!data || !ArrayBuffer.isView(data)) {
      return { saved: false, error: 'sem dados' as const };
    }
    // Nunca confiar no nome: reduzir a basename e limpar separadores.
    const raw = typeof payload?.filename === 'string' && payload.filename ? payload.filename : 'documento.pdf';
    const safe = path.basename(raw).replace(/[/\\]/g, '_') || 'documento.pdf';
    const ext = path.extname(safe).replace('.', '') || 'pdf';

    const win = mainWindow ?? BrowserWindow.getFocusedWindow();
    const options = {
      title: 'Guardar documento',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'Todos os ficheiros', extensions: ['*'] }]
    };
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { saved: false, canceled: true as const };

    await fs.promises.writeFile(filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    return { saved: true as const, path: filePath };
  });
}

function registerDocumentPrint() {
  ipcMain.handle('documents:print', async (_event, payload: { data?: Uint8Array }) => {
    const data = payload?.data;
    if (!data || !ArrayBuffer.isView(data)) {
      return { printed: false, error: 'sem dados' as const };
    }

    const tempDir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'ispm-print-'));
    const filePath = path.join(tempDir, 'documento.pdf');
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    try {
      await fs.promises.writeFile(filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      await printWindow.loadFile(filePath);
      const result = await new Promise<{ printed: boolean; canceled?: boolean; error?: string }>((resolve) => {
        printWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
          if (success) {
            resolve({ printed: true });
            return;
          }
          resolve({
            printed: false,
            canceled: /cancel/i.test(failureReason || ''),
            error: failureReason || 'Nao foi possivel imprimir o documento'
          });
        });
      });
      return result;
    } finally {
      if (!printWindow.isDestroyed()) printWindow.close();
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

/**
 * Auto-update via GitHub Releases (feed em `build.publish`). Descarrega em
 * silêncio e, quando pronto, pergunta se reinicia. Só em produção — em dev o
 * electron-updater não tem `app-update.yml`. Qualquer falha (offline, sem
 * release) é registada e ignorada: nunca pode impedir o uso da app.
 */
function initAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async (info) => {
    const options = {
      type: 'info' as const,
      buttons: ['Reiniciar e instalar agora', 'Instalar ao fechar a aplicação'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      icon: nativeImage.createFromPath(appIconPath()),
      title: 'Atualização do ISPM',
      message: `Nova atualização detetada — ISPM ${info.version}`,
      detail:
        `Versão instalada: ${appVersion()}\n` +
        `Nova versão: ${info.version}\n\n` +
        'Deseja reiniciar e instalar a atualização agora? Se preferir continuar a trabalhar, ' +
        'a atualização é instalada automaticamente quando fechar a aplicação.'
    };
    // Modal sobre a janela principal quando existe — não fica perdido atrás.
    const { response } = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err instanceof Error ? err.message : err);
  });
  void autoUpdater.checkForUpdates();
}

async function createWindow() {
  const iconPath = appIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: 'ISPM',
    // Acrílico Win11: o fundo da janela é o material do sistema e o CSS pinta
    // um véu escuro semi-transparente por cima (:root). backgroundColor com
    // alpha 00 para não tapar o material; onde não houver suporte o véu
    // assenta sobre a cor de fallback do compositor. Fora do Windows não há
    // backgroundMaterial e alpha 00 daria janela transparente → fundo opaco
    // igual ao theme-color dark do index.html.
    ...(process.platform === 'win32'
      ? { backgroundColor: '#00000000', backgroundMaterial: 'acrylic' as const }
      : { backgroundColor: '#05070D' }),
    icon: iconPath,
    webPreferences: {
      // Em dev o main corre via tsx a partir de src/main, mas o preload tem de ser
      // JS compilado: dev:main faz `tsc -p tsconfig.preload.json` → dist/main/preload.js
      // (relativo a __dirname = src/main, não a process.cwd() que pode variar).
      preload: isDevelopment
        ? path.join(__dirname, '..', '..', 'dist', 'main', 'preload.js')
        : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error);
  });

  if (isDevelopment) {
    await mainWindow.loadURL('http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  buildAppMenu();

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

  ipcMain.handle('dialog:choose-backup-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Pasta de destino dos backups',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('backups:open-dir', async (_event, dir: string) => {
    if (typeof dir !== 'string' || dir.length === 0) return;
    await shell.openPath(dir);
  });

  /**
   * Abre um URL no browser do sistema — usado pela descoberta de rede para
   * chegar à interface web de um equipamento encontrado.
   *
   * A lista branca de esquemas é a razão de existir deste handler. O URL nasce
   * de um endereço lido da rede; entregá-lo a `openExternal` sem filtro deixaria
   * passar `file:`, `javascript:` e qualquer protocolo registado no sistema
   * operativo — execução arbitrária a partir de dados que não controlamos.
   */
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || url.length > 2048) return false;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    await shell.openExternal(parsed.toString());
    return true;
  });

  registerDocumentSave();
  registerDocumentPrint();

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

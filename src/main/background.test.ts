import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  app: { isPackaged: true, getPath: vi.fn(), on: vi.fn(), quit: vi.fn(),
    getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() },
  tray: { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() },
  image: { isEmpty: vi.fn(() => false), resize: vi.fn(() => ({})) },
  menu: vi.fn((items) => items)
}));
vi.mock('electron', () => ({
  app: electron.app,
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => electron.handlers.set(name, handler) },
  Menu: { buildFromTemplate: electron.menu },
  nativeImage: { createFromPath: () => electron.image },
  Tray: vi.fn(function () { return electron.tray; })
}));
import { createBackgroundController } from './background';

describe('background controller', () => {
  let dir: string;
  let win: EventEmitter & { webContents: { mainFrame: object }; isDestroyed: () => boolean;
    isMinimized: () => boolean; restore: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    electron.handlers.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ispm-background-'));
    vi.stubEnv('ISPM_DATA_DIR', dir);
    electron.app.getPath.mockReturnValue(dir);
    electron.image.isEmpty.mockReturnValue(false);
    win = Object.assign(new EventEmitter(), { webContents: { mainFrame: {} }, isDestroyed: () => false,
      isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), hide: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function setup() {
    // The test window is an EventEmitter implementing only the Electron surface used here.
    const controller = createBackgroundController('icon.png', () => win as any);
    controller.attach(win as any);
    return controller;
  }
  function sender() { return { sender: win.webContents, senderFrame: win.webContents.mainFrame }; }

  it('hides on close, restores from the tray and lets explicit exit close the window', () => {
    const controller = setup();
    const preventDefault = vi.fn();
    win.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    const menu = electron.menu.mock.results[0].value;
    menu[0].click();
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    menu[2].click();
    expect(electron.app.quit).toHaveBeenCalledOnce();
    controller.beginQuit();
    preventDefault.mockClear();
    win.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it('does not block OS shutdown', () => {
    setup();
    win.emit('query-session-end');
    const preventDefault = vi.fn();
    win.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it('persists preference changes and applies them immediately', () => {
    setup();
    const result = electron.handlers.get('background:set')!(sender(), { keepRunning: false });
    expect(result.keepRunning).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'background.json'), 'utf8'))).toEqual({ keepRunning: false });
    const preventDefault = vi.fn();
    win.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    setup();
    expect(electron.handlers.get('background:get')!().keepRunning).toBe(false);
  });
  it('rejects subframes and other windows without writing preferences', () => {
    setup();
    const set = electron.handlers.get('background:set')!;
    expect(() => set({ ...sender(), senderFrame: {} }, { keepRunning: false })).toThrow('não autorizada');
    expect(() => set({ ...sender(), sender: {} }, { keepRunning: false })).toThrow('não autorizada');
    expect(fs.existsSync(path.join(dir, 'background.json'))).toBe(false);
  });
  it('isolates preview settings and never registers preview executables at login', () => {
    setup();
    expect(electron.handlers.get('background:get')!().canStartAtLogin).toBe(false);
    expect(() => electron.handlers.get('background:set')!(sender(), { openAtLogin: true })).toThrow('indisponível');
    expect(electron.app.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('fails visibly when the tray cannot be created instead of hiding an inaccessible process', () => {
    electron.image.isEmpty.mockReturnValue(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = setup();
    const preventDefault = vi.fn();
    win.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(controller.startHidden()).toBe(false);
    expect(() => electron.handlers.get('background:set')!(sender(), { keepRunning: true })).toThrow('bandeja');
    log.mockRestore();
  });
});

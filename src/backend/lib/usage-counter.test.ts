import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrate';
import { readClientUsageData, readWanUsageData, RouterError, type RouterRequest, type RouterTransport } from './routeros';
import { installUsageCounter, refreshUsageCounter, refreshUsageCounterForJob, usageCounterDisk } from './usage-counter';

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

type Row = Record<string, unknown>;

/** Um router de mentira: scripts, agendamentos, discos e ficheiros em memória. */
function router({ disks = [] as string[], scripts = [] as Row[], files = {} as Record<string, string> } = {}) {
  const schedulers: Row[] = [];
  const calls: RouterRequest[] = [];
  let nextId = 1;
  const transport: RouterTransport = async (request) => {
    calls.push(request);
    const { method, path } = request;
    const body = request.body as Row | undefined;
    if (method === 'GET' && path === '/disk') return disks.map((slot) => (slot.startsWith('raw') ? { slot, fs: '-' } : { slot, fs: 'ext4' }));
    if (method === 'GET' && path.startsWith('/system/script?name=')) {
      const name = /name=([^&]+)/.exec(path)![1];
      return scripts.filter((row) => row.name === name);
    }
    if (method === 'GET' && path.startsWith('/system/script?')) return scripts;
    if (method === 'GET' && path.startsWith('/system/scheduler')) return schedulers;
    if (method === 'GET' && path.startsWith('/file?name=')) {
      const name = decodeURIComponent(/name=([^&]+)/.exec(path)![1]);
      return name in files ? [{ name, size: String(files[name].length) }] : [];
    }
    if (method === 'PUT' && path === '/system/script') scripts.push({ '.id': `*${nextId++}`, invalid: 'false', ...body });
    if (method === 'PATCH' && path.startsWith('/system/script/')) Object.assign(scripts.find((row) => `/system/script/${row['.id']}` === path)!, body);
    if (method === 'PUT' && path === '/system/scheduler') schedulers.push({ '.id': `*${nextId++}`, ...body });
    if (method === 'POST' && path === '/execute') return { ret: files[/get "([^"]+)" contents/.exec(String(body!.script))![1]] };
    return null;
  };
  return { transport, calls, scripts, schedulers, files };
}

const setting = (db: Database.Database, key: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

describe('instalação dos contadores', () => {
  test('com disco, o contador guarda o estado num ficheiro e o ISPM lembra-se de onde', async () => {
    const db = memoryDb();
    const fake = router({ disks: ['sd1'] });
    expect(await installUsageCounter(db, fake.transport, 'wan')).toEqual({ disk: 'sd1' });
    expect(fake.scripts[0]).toMatchObject({ name: 'ispm-wan-usage', comment: 'ispm-wan-usage v7 @sd1', policy: 'read,write' });
    // O ficheiro só se usa com o disco montado: sem ele, um `/file add` escrevia na memória interna.
    expect(fake.scripts[0].source).toContain(':if ([:len [/file find where name="sd1" type="disk"]] > 0) do={ :set dataFile "sd1/ispm-wan-usage.txt" }');
    // A corrida logo a seguir é a que passa o estado antigo para o ficheiro.
    expect(fake.calls.at(-1)).toMatchObject({ method: 'POST', path: '/system/script/run', body: { '.id': 'ispm-wan-usage' } });
    expect(setting(db, 'wanUsageCounter')).toBe('ispm-wan-usage v7 @sd1');
    expect(usageCounterDisk(db, 'wan')).toBe('sd1');
    expect(usageCounterDisk(db, 'client')).toBeNull();
  });

  test('sem disco fica no script de dados, como antes', async () => {
    const db = memoryDb();
    const fake = router();
    expect(await installUsageCounter(db, fake.transport, 'client')).toEqual({ disk: null });
    expect(fake.scripts[0]).toMatchObject({ name: 'ispm-client-usage', comment: 'ispm-client-usage v3' });
    expect(fake.scripts[0].source).toContain(':local dataFile ""');
    expect(fake.scripts[0].source).not.toContain('type="disk"');
    expect(usageCounterDisk(db, 'client')).toBeNull();
  });

  test('um disco por formatar não serve', async () => {
    const db = memoryDb();
    expect(await installUsageCounter(db, router({ disks: ['raw1'] }).transport, 'wan')).toEqual({ disk: null });
    expect(await installUsageCounter(db, router({ disks: ['raw1', 'usb1'] }).transport, 'wan')).toEqual({ disk: 'usb1' });
  });

  test('prefere o disco do diário do registo, se o router ainda o tiver', async () => {
    const db = memoryDb();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('routerLogJournal', 'usb1')").run();
    expect(await installUsageCounter(db, router({ disks: ['sd1', 'usb1'] }).transport, 'wan')).toEqual({ disk: 'usb1' });
    expect(await installUsageCounter(db, router({ disks: ['sd1'] }).transport, 'wan')).toEqual({ disk: 'sd1' });
  });

  test('uma instalação que falha não fica assumida', async () => {
    const db = memoryDb();
    const fake = router({ disks: ['sd1'] });
    const failing: RouterTransport = async (request) => {
      if (request.path === '/system/script/run') throw new RouterError('sem resposta', 0);
      return fake.transport(request);
    };
    await expect(installUsageCounter(db, failing, 'wan')).rejects.toThrow('sem resposta');
    expect(setting(db, 'wanUsageCounter')).toBeNull();
  });
});

describe('atualização de um contador antigo', () => {
  const old = () => [{ '.id': '*9', name: 'ispm-wan-usage', comment: 'ispm-wan-usage v6', source: '# ispm-wan-usage v6', invalid: 'false' }];

  test('o que já está no router numa versão antiga atualiza-se uma vez', async () => {
    const db = memoryDb();
    const fake = router({ disks: ['sd1'], scripts: old() });
    expect(await refreshUsageCounter(db, fake.transport, 'wan', true)).toBe(true);
    expect(fake.scripts[0].comment).toBe('ispm-wan-usage v7 @sd1');
    fake.calls.length = 0;
    expect(await refreshUsageCounter(db, fake.transport, 'wan', true)).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  test('no trabalho, uma atualização que falha fica dita e não rebenta', async () => {
    const db = memoryDb();
    const fake = router({ disks: ['sd1'], scripts: old() });
    const invalid: RouterTransport = async (request) => {
      const reply = await fake.transport(request);
      return request.path.includes('.proplist=source,invalid') ? [{ source: '# x', invalid: 'true' }] : reply;
    };
    expect(await refreshUsageCounterForJob(db, invalid, 'wan', true)).toEqual({ counterError: 'O router marcou o script do contador como inválido' });
    expect(await refreshUsageCounterForJob(db, fake.transport, 'wan', true)).toEqual({ counterUpdated: true });
    expect(await refreshUsageCounterForJob(db, fake.transport, 'wan', true)).toEqual({});
  });

  test('o que nunca foi instalado não se instala sozinho', async () => {
    const db = memoryDb();
    const fake = router({ disks: ['sd1'] });
    expect(await refreshUsageCounter(db, fake.transport, 'wan', false)).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});

describe('leitura do estado guardado', () => {
  const DATA = '# uptime;1d\n# 20736;WAN1;10;20\n';

  test('lê o ficheiro do disco quando já não há script de dados', async () => {
    const fake = router({ files: { 'sd1/ispm-wan-usage.txt': DATA, 'sd1/ispm-client-usage.txt': '# skn001;1;2;3;4;01:00:00\n' } });
    expect(await readWanUsageData(fake.transport, 'sd1')).toBe(DATA);
    expect(await readClientUsageData(fake.transport, 'sd1')).toBe('# skn001;1;2;3;4;01:00:00\n');
  });

  test('o script de dados, enquanto existir, é o mais recente', async () => {
    const fake = router({ scripts: [{ name: 'ispm-wan-usage-data', source: '# novo\n' }], files: { 'sd1/ispm-wan-usage.txt': DATA } });
    expect(await readWanUsageData(fake.transport, 'sd1')).toBe('# novo\n');
  });

  test('sem script nem ficheiro, o contador ainda não correu', async () => {
    expect(await readWanUsageData(router().transport, 'sd1')).toBeNull();
    expect(await readWanUsageData(router({ files: { 'sd1/ispm-wan-usage.txt': DATA } }).transport)).toBeNull();
  });

  test('um ficheiro que vem cortado rebenta em vez de importar a menos', async () => {
    const fake = router({ files: { 'sd1/ispm-wan-usage.txt': DATA } });
    const cut: RouterTransport = async (request) => (request.path === '/execute' ? { ret: DATA.slice(0, 5) } : fake.transport(request));
    await expect(readWanUsageData(cut, 'sd1')).rejects.toThrow('sd1/ispm-wan-usage.txt');
  });
});

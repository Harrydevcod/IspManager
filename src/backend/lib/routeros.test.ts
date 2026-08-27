import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  createSecret,
  listActive,
  listSecrets,
  patchSecret,
  readRouterConfig,
  removeActive,
  testConnection,
  type RouterRequest,
  listNeighbors,
  neighborModel,
  type RouterTransport
} from './routeros';

/** Transporte falso: guarda as chamadas e devolve o que o teste mandar. */
function fakeTransport(responses: unknown[] = []): RouterTransport & { calls: RouterRequest[] } {
  const calls: RouterRequest[] = [];
  const transport = (async (req: RouterRequest) => {
    calls.push(req);
    return responses.shift() ?? null;
  }) as RouterTransport & { calls: RouterRequest[] };
  transport.calls = calls;
  return transport;
}

function memoryDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('readRouterConfig', () => {
  test('vem desligado e em dry-run quando nada está configurado', () => {
    const db = memoryDb();
    const config = readRouterConfig(db);
    expect(config.enabled).toBe(false);
    expect(config.dryRun).toBe(true);
    expect(config.port).toBe(443);
    expect(config.maxDisablesPerRun).toBe(5);
    db.close();
  });

  test('o dry-run só se desliga com a chave explicitamente a "false"', () => {
    const db = memoryDb();
    const set = (key: string, value: string) =>
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
    set('routerosDryRun', 'nao-sei-o-que-isto-e');
    expect(readRouterConfig(db).dryRun).toBe(true);
    set('routerosDryRun', 'false');
    expect(readRouterConfig(db).dryRun).toBe(false);
    db.close();
  });

  test('valores fora dos limites caem no valor por omissão', () => {
    const db = memoryDb();
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('routerosIntervalSeconds', '5');
    expect(readRouterConfig(db).intervalSeconds).toBe(120);
    db.close();
  });
});

describe('operações RouterOS', () => {
  test('testConnection lê versão e board', async () => {
    const transport = fakeTransport([[{ version: '7.15.3', 'board-name': 'hEX S' }]]);
    await expect(testConnection(transport)).resolves.toEqual({ version: '7.15.3', boardName: 'hEX S' });
    expect(transport.calls[0]).toEqual({
      method: 'GET',
      path: '/system/resource?.proplist=version,board-name'
    });
  });

  test('listSecrets normaliza booleanos em texto e descarta linhas sem id', async () => {
    const transport = fakeTransport([
      [
        { '.id': '*1', name: 'joao-12', disabled: 'true', 'rate-limit': '2M/10M', comment: 'ispm:12' },
        { '.id': '*2', name: 'ana-13', disabled: 'false' },
        { name: 'sem-id' }
      ]
    ]);
    const secrets = await listSecrets(transport);
    expect(secrets).toEqual([
      { id: '*1', name: 'joao-12', disabled: true, profile: null, rateLimit: '2M/10M', comment: 'ispm:12' },
      { id: '*2', name: 'ana-13', disabled: false, profile: null, rateLimit: null, comment: null }
    ]);
  });

  test('listActive devolve as sessões vivas', async () => {
    const transport = fakeTransport([[{ '.id': '*A', name: 'joao-12', address: '10.0.0.5', uptime: '3h2m' }]]);
    await expect(listActive(transport)).resolves.toEqual([
      { id: '*A', name: 'joao-12', address: '10.0.0.5', uptime: '3h2m' }
    ]);
  });

  test('createSecret usa PUT (o "add" do RouterOS) e marca o serviço no comment', async () => {
    const transport = fakeTransport([{ '.id': '*7' }]);
    const id = await createSecret(transport, {
      name: 'joao-12',
      password: 'abc123',
      comment: 'ispm:12',
      rateLimit: '2M/10M'
    });
    expect(id).toBe('*7');
    expect(transport.calls[0]).toEqual({
      method: 'PUT',
      path: '/ppp/secret',
      body: {
        name: 'joao-12',
        password: 'abc123',
        service: 'pppoe',
        comment: 'ispm:12',
        'rate-limit': '2M/10M'
      }
    });
  });

  test('patchSecret escreve "yes"/"no", que é o que o RouterOS entende', async () => {
    const transport = fakeTransport([null, null]);
    await patchSecret(transport, '*1', { disabled: true });
    await patchSecret(transport, '*1', { disabled: false, rateLimit: '2M/10M' });
    expect(transport.calls[0]).toEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(transport.calls[1]).toEqual({
      method: 'PATCH',
      path: '/ppp/secret/*1',
      body: { disabled: 'no', 'rate-limit': '2M/10M' }
    });
  });

  test('patchSecret sem nada para mudar não chega a falar com o router', async () => {
    const transport = fakeTransport();
    await patchSecret(transport, '*1', {});
    expect(transport.calls).toHaveLength(0);
  });

  test('removeActive derruba a sessão com DELETE', async () => {
    const transport = fakeTransport([null]);
    await removeActive(transport, '*A');
    expect(transport.calls[0]).toEqual({ method: 'DELETE', path: '/ppp/active/*A' });
  });

  test('um erro do transporte sobe ao chamador em vez de virar lista vazia', async () => {
    const transport = (async () => {
      throw new Error('ECONNREFUSED');
    }) as RouterTransport;
    await expect(listSecrets(transport)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('listNeighbors — modelo sem tocar em cada equipamento', () => {
  test('lê os vizinhos que se anunciaram ao router de gestão', async () => {
    const transport = fakeTransport([[
      {
        address: '10.0.0.2',
        'mac-address': 'CC:2D:E0:11:22:33',
        identity: 'torre-norte',
        platform: 'MikroTik',
        board: 'RB951Ui-2HnD',
        version: '7.15.3'
      }
    ]]);

    const [neighbor] = await listNeighbors(transport);
    expect(neighbor.address).toBe('10.0.0.2');
    expect(neighbor.board).toBe('RB951Ui-2HnD');
    expect(neighbor.identity).toBe('torre-norte');
    // Pede só as propriedades que interessam — o `/ip/neighbor` completo é
    // muito maior e nada disso chega a ser usado.
    expect(transport.calls[0].path).toContain('.proplist=');
    expect(transport.calls[0].method).toBe('GET');
  });

  test('vizinho sem endereço não entra — não há onde o pousar', async () => {
    const transport = fakeTransport([[{ identity: 'sem-ip', board: 'RB750' }]]);
    expect(await listNeighbors(transport)).toEqual([]);
  });
});

describe('neighborModel', () => {
  const neighbor = (over: Partial<Awaited<ReturnType<typeof listNeighbors>>[number]> = {}) => ({
    address: '10.0.0.2',
    macAddress: null,
    identity: null,
    platform: null,
    board: null,
    version: null,
    systemDescription: null,
    ...over
  });

  test('o nome da placa é literalmente o modelo', () => {
    expect(neighborModel(neighbor({ board: 'RB951Ui-2HnD', platform: 'MikroTik' }))).toBe('RB951Ui-2HnD');
  });

  test('sem placa serve a descrição LLDP, cortada', () => {
    expect(neighborModel(neighbor({ systemDescription: 'X'.repeat(200) }))).toHaveLength(120);
  });

  test('o fabricante sozinho não passa por modelo', () => {
    expect(neighborModel(neighbor({ platform: 'MikroTik' }))).toBeNull();
  });
});

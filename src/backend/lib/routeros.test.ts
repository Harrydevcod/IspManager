import { createServer } from 'node:https';
import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  auditPppAccess,
  auditRouterHardening,
  auditRouterServices,
  readRouterHardening,
  rosQuote,
  createTransport,
  createProfile,
  ensureWanUsageCounter,
  ensureClientUsageCounter,
  ensureRouterScript,
  listAddressList,
  removeAddressListEntry,
  createSecret,
  describeRouterFailure,
  listProfiles,
  patchProfile,
  readWanUsageData,
  diagnoseRouter,
  isRouterConfigured,
  listActive,
  listSecrets,
  patchSecret,
  readRouterConfig,
  resetRouterAgentCacheForTests,
  removeActive,
  RouterError,
  testConnection,
  readSystem,
  listInterfaces,
  listInterfaceListMembers,
  monitorTraffic,
  listLog,
  summarizeLog,
  DHCP_CHURN_THRESHOLD,
  type RouterFirewallRule,
  type RouterHardening,
  type RouterRequest,
  type RouterService,
  listArp,
  listBridgeHosts,
  listNeighbors,
  neighborModel,
  type RouterTransport
} from './routeros';
import { TEST_ROUTER_CA_PEM, TEST_ROUTER_KEY_PEM, TEST_ROUTER_LEAF_PEM } from './routerosTestCerts';

afterEach(resetRouterAgentCacheForTests);

test('listBridgeHosts reads only remote MACs and their observed ports', async () => {
  const requests: RouterRequest[] = [];
  const transport: RouterTransport = async (request) => {
    requests.push(request);
    return [
      { 'mac-address': 'AA:BB:CC:00:00:02', 'on-interface': 'ether3', local: 'false' },
      { 'mac-address': 'AA:BB:CC:00:00:01', 'on-interface': 'bridge', local: 'true' },
      { 'mac-address': 'AA:BB:CC:00:00:03', local: 'false' }
    ];
  };
  expect(await listBridgeHosts(transport)).toEqual([{ macAddress: 'AA:BB:CC:00:00:02', onInterface: 'ether3' }]);
  expect(requests).toEqual([{ method: 'GET', path: '/interface/bridge/host?.proplist=mac-address,on-interface,local' }]);
});

function localConfig(port: number, tlsCert = TEST_ROUTER_LEAF_PEM + TEST_ROUTER_CA_PEM) {
  return {
    enabled: true, host: '127.0.0.1', port, user: 'ispm', password: 'segredo',
    dryRun: true, intervalSeconds: 120, tlsCert, maxDisablesPerRun: 5
  };
}

async function withHttpsServer(
  onRequest: (requestNumber: number, socket: import('node:net').Socket, respond: () => void) => void,
  run: (port: number, connections: () => number, requests: () => number, tcpConnections: () => number) => Promise<void>
) {
  let connections = 0;
  let tcpConnections = 0;
  let requests = 0;
  const server = createServer({ cert: TEST_ROUTER_LEAF_PEM + TEST_ROUTER_CA_PEM, key: TEST_ROUTER_KEY_PEM }, (_req, res) => {
    requests += 1;
    onRequest(requests, res.socket!, () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on('secureConnection', () => { connections += 1; });
  server.on('connection', () => { tcpConnections += 1; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as { port: number }).port, () => connections, () => requests, () => tcpConnections);
  } finally {
    resetRouterAgentCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('ligação HTTPS reutilizada', () => {
  test('dois GET de transportes diferentes usam a mesma ligação TLS', async () => {
    await withHttpsServer((_number, _socket, respond) => respond(), async (port, connections) => {
      const config = localConfig(port);
      await createTransport(config)({ method: 'GET', path: '/system/resource' });
      await createTransport(config)({ method: 'GET', path: '/system/resource' });
      expect(connections()).toBe(1);
    });
  });

  test('trocar o certificado fixado abre outra ligação e recusa a identidade errada', async () => {
    await withHttpsServer((_number, _socket, respond) => respond(), async (port, _connections, _requests, tcpConnections) => {
      await createTransport(localConfig(port))({ method: 'GET', path: '/system/resource' });
      await expect(createTransport(localConfig(port, TEST_ROUTER_CA_PEM))({ method: 'GET', path: '/system/resource' }))
        .rejects.toMatchObject({ code: 'CERT_MISMATCH' });
      expect(tcpConnections()).toBe(2);
    });
  });

  test('repete uma vez um GET quando o router fecha a ligação reutilizada', async () => {
    await withHttpsServer((number, socket, respond) => {
      if (number === 2) socket.destroy();
      else respond();
    }, async (port, connections, requests) => {
      const transport = createTransport(localConfig(port));
      await transport({ method: 'GET', path: '/system/resource' });
      await expect(transport({ method: 'GET', path: '/system/resource' })).resolves.toEqual({ ok: true });
      expect(requests()).toBe(3);
      expect(connections()).toBe(2);
    });
  });

  test('não repete PATCH quando o router fecha a ligação reutilizada', async () => {
    await withHttpsServer((number, socket, respond) => {
      if (number === 2) socket.destroy();
      else respond();
    }, async (port, _connections, requests) => {
      const transport = createTransport(localConfig(port));
      await transport({ method: 'GET', path: '/system/resource' });
      await expect(transport({ method: 'PATCH', path: '/ppp/secret', body: { name: 'x' } }))
        .rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(requests()).toBe(2);
    });
  });
});

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

describe('isRouterConfigured', () => {
  const base = { enabled: true, host: '192.168.2.1', port: 443, user: 'ispm-api', password: 'x', dryRun: true, intervalSeconds: 120, tlsCert: '', maxDisablesPerRun: 5 };

  // Medido no router real: com a senha selada por abrir (cópia da base noutra
  // conta), o job batia no router a cada 2 min com a senha vazia — um 401 no
  // registo do router por passagem — enquanto o diagnóstico dizia "falta a senha".
  test('sem senha o router não está configurado', () => {
    expect(isRouterConfigured(base)).toBe(true);
    expect(isRouterConfigured({ ...base, password: '' })).toBe(false);
  });
});

describe('operações RouterOS', () => {
  test('instala o contador uma vez e não repete escritas quando já está correto', async () => {
    const calls: RouterRequest[] = [];
    const scripts: Record<string, unknown>[] = [];
    const schedulers: Record<string, unknown>[] = [];
    const transport: RouterTransport = async (request) => {
      calls.push(request);
      if (request.method === 'GET') return request.path.startsWith('/system/script?') ? scripts : schedulers;
      const body = request.body as Record<string, unknown>;
      if (request.method === 'PUT' && request.path === '/system/script') scripts.push({ '.id': '*1', ...body });
      if (request.method === 'PUT' && request.path === '/system/scheduler') schedulers.push({ '.id': `*${schedulers.length + 2}`, ...body });
      return null;
    };
    await ensureWanUsageCounter(transport);
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(3);
    expect((scripts[0].source as string)).toContain('ispm-wan-usage v8');
    expect(schedulers.map((row) => row.name)).toEqual(['ispm-wan-usage', 'ispm-wan-usage-startup']);
    calls.length = 0;
    await ensureWanUsageCounter(transport);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
  });

  test('instala o contador dos clientes com os dois agendamentos', async () => {
    const scripts: Record<string, unknown>[] = [];
    const schedulers: Record<string, unknown>[] = [];
    const transport: RouterTransport = async (request) => {
      if (request.method === 'GET') return request.path.startsWith('/system/script?') ? scripts : schedulers;
      const body = request.body as Record<string, unknown>;
      if (request.method === 'PUT' && request.path === '/system/script') scripts.push({ '.id': '*1', ...body });
      if (request.method === 'PUT' && request.path === '/system/scheduler') schedulers.push({ '.id': `*${schedulers.length + 2}`, ...body });
      return null;
    };
    await ensureClientUsageCounter(transport);
    expect((scripts[0].source as string)).toContain('ispm-client-usage v4');
    expect(schedulers.map((row) => row.name)).toEqual(['ispm-client-usage', 'ispm-client-usage-startup']);
  });

  test('instala um script genérico com o intervalo pedido e não repete escritas', async () => {
    const calls: RouterRequest[] = [];
    const scripts: Record<string, unknown>[] = [];
    const schedulers: Record<string, unknown>[] = [];
    const transport: RouterTransport = async (request) => {
      calls.push(request);
      if (request.method === 'GET') return request.path.startsWith('/system/script?') ? scripts : schedulers;
      const body = request.body as Record<string, unknown>;
      if (request.method === 'PUT' && request.path === '/system/script') scripts.push({ '.id': '*1', ...body });
      if (request.method === 'PUT' && request.path === '/system/scheduler') schedulers.push({ '.id': `*${schedulers.length + 2}`, ...body });
      return null;
    };
    await ensureRouterScript(transport, { name: 'ispm-iptv', comment: 'ispm-iptv v1 #abcd1234', source: '# ispm-iptv v1\n', interval: '1m' });
    expect(schedulers.map((row) => [row.name, row.interval])).toEqual([['ispm-iptv', '1m'], ['ispm-iptv-startup', '0s']]);
    calls.length = 0;
    await ensureRouterScript(transport, { name: 'ispm-iptv', comment: 'ispm-iptv v1 #abcd1234', source: '# ispm-iptv v1\n', interval: '1m' });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'GET']);
  });

  test('lê só as entradas estáticas de uma lista, pelo nome', async () => {
    const transport = fakeTransport([[
      { '.id': '*A', address: 'line.dino.ws', comment: 'manual', dynamic: 'false', disabled: 'false' },
      { '.id': '*B', address: '1.2.3.4', comment: 'manual', dynamic: 'true', disabled: 'false' }
    ]]);
    expect(await listAddressList(transport, 'IPTV-SERVERS')).toEqual([{ id: '*A', address: 'line.dino.ws', comment: 'manual', disabled: false }]);
    expect(transport.calls[0].path).toBe('/ip/firewall/address-list?list=IPTV-SERVERS&.proplist=.id,address,comment,dynamic,disabled');
  });

  test('removeAddressListEntry recusa um .id inválido e aceita o do RouterOS', async () => {
    const transport = fakeTransport();
    await expect(removeAddressListEntry(transport, '1')).rejects.toThrow('inválido');
    expect(transport.calls).toHaveLength(0);
    await removeAddressListEntry(transport, '*A');
    expect(transport.calls).toEqual([{ method: 'DELETE', path: '/ip/firewall/address-list/*A' }]);
  });

  // Medido no router real: o PUT foi aceite e o script ficou vazio e INVALID, sem erro.
  test('recusa a instalação quando o router guarda o script vazio ou inválido', async () => {
    const empty = fakeTransport([[], null, [{ source: '', invalid: 'true' }]]);
    await expect(ensureWanUsageCounter(empty)).rejects.toThrow('sem texto');
    const invalid = fakeTransport([[], null, [{ source: '# x', invalid: 'true' }]]);
    await expect(ensureWanUsageCounter(invalid)).rejects.toThrow('inválido');
  });

  test('lê os totais do script de dados e devolve null quando o contador ainda não correu', async () => {
    const found = fakeTransport([[{ source: '# 2026-09-25;WAN;1;2\n' }]]);
    await expect(readWanUsageData(found)).resolves.toBe('# 2026-09-25;WAN;1;2\n');
    await expect(readWanUsageData(fakeTransport([[]]))).resolves.toBeNull();
  });

  test('atualiza a versão antiga do script e os campos dos schedulers', async () => {
    const transport = fakeTransport([
      [{ '.id': '*1', name: 'ispm-wan-usage', comment: 'ispm-wan-usage v0' }], null,
      [{ source: '# ispm-wan-usage v6', invalid: 'false' }],
      [
        { '.id': '*2', name: 'ispm-wan-usage', 'on-event': 'outro', 'start-time': '01:00:00', interval: '10m', policy: 'read' },
        { '.id': '*3', name: 'ispm-wan-usage-startup', 'on-event': 'ispm-wan-usage', 'start-time': 'startup', interval: '0s', policy: 'read,write' }
      ], null
    ]);
    await ensureWanUsageCounter(transport);
    expect(transport.calls.filter((call) => call.method === 'PATCH').map((call) => call.path))
      .toEqual(['/system/script/*1', '/system/scheduler/*2']);
  });

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
        { '.id': '*1', name: 'joao-12', disabled: 'true', profile: 'plano-10M', comment: 'ispm:12' },
        { '.id': '*2', name: 'ana-13', disabled: 'false' },
        { name: 'sem-id' }
      ]
    ]);
    const secrets = await listSecrets(transport);
    expect(secrets).toEqual([
      { id: '*1', name: 'joao-12', disabled: true, profile: 'plano-10M', comment: 'ispm:12' },
      { id: '*2', name: 'ana-13', disabled: false, profile: null, comment: null }
    ]);
  });

  test('listActive devolve as sessões vivas, com o MAC de quem discou', async () => {
    const transport = fakeTransport([[
      { '.id': '*A', name: 'joao-12', address: '10.0.0.5', uptime: '3h2m', 'caller-id': 'BC:07:1D:5E:42:9F' },
      { '.id': '*B', name: 'ana-13' }
    ]]);
    await expect(listActive(transport)).resolves.toEqual([
      { id: '*A', name: 'joao-12', address: '10.0.0.5', uptime: '3h2m', callerId: 'BC:07:1D:5E:42:9F' },
      { id: '*B', name: 'ana-13', address: null, uptime: null, callerId: null }
    ]);
    expect(transport.calls[0].path).toContain('caller-id');
  });

  test('createSecret usa PUT (o "add" do RouterOS) e marca o serviço no comment', async () => {
    const transport = fakeTransport([{ '.id': '*7' }]);
    const id = await createSecret(transport, {
      name: 'joao-12',
      password: 'abc123',
      comment: 'ispm:12',
      profile: 'plano-10M'
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
        profile: 'plano-10M'
      }
    });
  });

  test('patchSecret escreve "yes"/"no", que é o que o RouterOS entende', async () => {
    const transport = fakeTransport([null, null]);
    await patchSecret(transport, '*1', { disabled: true });
    await patchSecret(transport, '*1', { disabled: false, profile: 'plano-10M' });
    expect(transport.calls[0]).toEqual({ method: 'PATCH', path: '/ppp/secret/*1', body: { disabled: 'yes' } });
    expect(transport.calls[1]).toEqual({
      method: 'PATCH',
      path: '/ppp/secret/*1',
      body: { disabled: 'no', profile: 'plano-10M' }
    });
  });

  test('uma password ainda cifrada nunca chega ao router', async () => {
    const transport = fakeTransport();
    const sealed = 'enc:v2:bm9uY2U:dGFn:Y3Q';
    await expect(createSecret(transport, { name: 'joao-12', password: sealed, comment: 'ispm:12' }))
      .rejects.toThrow('Password PPPoE por decifrar');
    await expect(patchSecret(transport, '*1', { password: sealed }))
      .rejects.toThrow('Password PPPoE por decifrar');
    expect(transport.calls).toHaveLength(0);
  });

  test('listProfiles normaliza os perfis e descarta linhas sem id', async () => {
    const transport = fakeTransport([
      [
        { '.id': '*0', name: 'default', 'local-address': '10.10.0.1', 'remote-address': 'pool-clientes', 'dns-server': '1.1.1.1', 'only-one': 'yes' },
        { '.id': '*A', name: 'plano-20M', 'rate-limit': '20M/20M', comment: 'ispm:plano:1' },
        { name: 'sem-id' }
      ]
    ]);
    await expect(listProfiles(transport)).resolves.toEqual([
      { id: '*0', name: 'default', rateLimit: null, localAddress: '10.10.0.1', remoteAddress: 'pool-clientes', dnsServer: '1.1.1.1', onlyOne: 'yes', interfaceList: null, parentQueue: null, comment: null },
      { id: '*A', name: 'plano-20M', rateLimit: '20M/20M', localAddress: null, remoteAddress: null, dnsServer: null, onlyOne: null, interfaceList: null, parentQueue: null, comment: 'ispm:plano:1' }
    ]);
    expect(transport.calls[0]).toEqual({
      method: 'GET',
      path: '/ppp/profile?.proplist=.id,name,rate-limit,local-address,remote-address,dns-server,only-one,interface-list,parent-queue,comment'
    });
  });

  test('createProfile envia os campos dados e devolve o .id do router', async () => {
    const transport = fakeTransport([{ '.id': '*B' }]);
    const fields = { name: 'plano-20M', comment: 'ispm:plano:1', 'rate-limit': '20M/20M', 'local-address': '10.10.0.1', 'interface-list': 'PPPOE' };
    expect(await createProfile(transport, fields)).toBe('*B');
    expect(transport.calls[0]).toEqual({ method: 'PUT', path: '/ppp/profile', body: fields });
  });

  test('patchProfile muda só os campos dados, pelo .id', async () => {
    const transport = fakeTransport([null]);
    await patchProfile(transport, '*B', { 'parent-queue': 'fila-total' });
    expect(transport.calls[0]).toEqual({ method: 'PATCH', path: '/ppp/profile/*B', body: { 'parent-queue': 'fila-total' } });
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

describe('listArp', () => {
  test('entrada sem MAC não entra — é o router a ter perguntado sem resposta', async () => {
    // Varrer uma /24 através do router deixa-lhe uma linha destas por cada
    // endereço morto. Na base real eram 398 "desconhecidos" que não existiam.
    const transport = fakeTransport([[
      { address: '192.168.1.22', 'mac-address': '3C:78:95:BF:8D:E0', interface: 'bridge', dynamic: 'true' },
      { address: '192.168.1.10', interface: 'bridge', dynamic: 'true' }
    ]]);
    const entries = await listArp(transport);
    expect(entries.map((entry) => entry.address)).toEqual(['192.168.1.22']);
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

describe('describeRouterFailure', () => {
  function nodeError(code: string): NodeJS.ErrnoException {
    const err = new Error(`connect ${code} 10.0.0.1:443`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  test('cada causa conhecida dá um título próprio e não vaza o erro do Node', () => {
    const codes = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_MISMATCH'
    ];
    const titles = codes.map((code) => describeRouterFailure(nodeError(code)).title);
    expect(new Set(titles).size).toBe(codes.length);
    for (const title of titles) {
      expect(title).not.toMatch(/connect E|SELF_SIGNED/);
    }
  });

  test('a porta recusada manda ligar o www-ssl', () => {
    const failure = describeRouterFailure(nodeError('ECONNREFUSED'));
    expect(failure.code).toBe('ECONNREFUSED');
    expect(failure.command).toContain('www-ssl');
  });

  test('401, 403 e 404 dizem coisas diferentes', () => {
    const unauthorized = describeRouterFailure(new RouterError('recusado', 401));
    const forbidden = describeRouterFailure(new RouterError('sem grupo', 403));
    const missing = describeRouterFailure(new RouterError('sem rota', 404));
    expect(unauthorized.title).toMatch(/senha/i);
    expect(forbidden.detail).toContain('rest-api');
    expect(missing.detail).toMatch(/RouterOS 7/);
    expect(new Set([unauthorized.title, forbidden.title, missing.title]).size).toBe(3);
  });

  test('o que não se conhece devolve a mensagem original em vez de inventar', () => {
    const failure = describeRouterFailure(new Error('coisa nunca vista'));
    expect(failure.code).toBe('unknown');
    expect(failure.detail).toBe('coisa nunca vista');
  });
});

describe('diagnoseRouter', () => {
  const baseConfig = {
    enabled: true,
    host: '',
    port: 443,
    user: '',
    password: '',
    dryRun: true,
    intervalSeconds: 120,
    tlsCert: '',
    maxDisablesPerRun: 5
  };

  test('sem campos preenchidos diz o que falta e não abre socket nenhum', async () => {
    const report = await diagnoseRouter({ ...baseConfig });
    expect(report.ok).toBe(false);
    expect(report.steps.map((step) => step.status)).toEqual(['fail', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(report.steps[0].detail).toContain('endereço');
    expect(report.steps[0].detail).toContain('senha');
  });

  test('porta fechada falha no alcance e não chega a testar credenciais', async () => {
    // Porta 1 em loopback: ninguém atende, e recusa de imediato.
    const report = await diagnoseRouter({
      ...baseConfig,
      host: '127.0.0.1',
      port: 1,
      user: 'ispm',
      password: 'segredo'
    });
    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(report.steps.map((step) => [step.id, step]));
    expect(byId.config.status).toBe('ok');
    expect(byId.reach.status).toBe('fail');
    expect(byId.cert.status).toBe('skipped');
    expect(byId.rest.status).toBe('skipped');
    expect(byId.hardening.status).toBe('skipped');
    expect(report.certificate).toBeNull();
  });
});

describe('auditRouterServices', () => {
  function service(over: Partial<RouterService>): RouterService {
    return { name: 'x', port: 1, disabled: false, address: null, certificate: null, ...over };
  }

  /** Como o router ficou depois de se aplicar o runbook. */
  const fechado: RouterService[] = [
    service({ name: 'ftp', port: 21, disabled: true }),
    service({ name: 'telnet', port: 23, disabled: true }),
    service({ name: 'www', port: 80, disabled: true }),
    service({ name: 'api', port: 8728, disabled: true }),
    service({ name: 'api-ssl', port: 8729, disabled: true }),
    service({ name: 'www-ssl', port: 443, certificate: 'ispm-cert' }),
    service({ name: 'winbox', port: 8291, address: '192.168.2.0/24' }),
    service({ name: 'ssh', port: 22, address: '192.168.2.0/24' }),
    service({ name: 'btest', port: 2000, disabled: true }),
    service({ name: 'discover', port: 5678 })
  ];

  test('um router fechado não dá achado nenhum', () => {
    expect(auditRouterServices(fechado)).toEqual([]);
  });

  // Medido no router real (RouterOS 7.24.2): a leitura de /ip/service veio sem
  // certificado no www-ssl, e o diagnóstico mandou desligá-lo — no mesmo
  // relatório em que o aperto TLS com o certificado fixado tinha passado. O
  // www-ssl é onde a REST do ISPM vive; desligá-lo corta o ISPM do router.
  test('nunca manda desligar o www-ssl, mesmo lido sem certificado', () => {
    const lido = fechado.map((s) => (s.name === 'www-ssl' ? { ...s, certificate: null } : s));
    const achados = auditRouterServices(lido);
    expect(achados.flatMap((a) => a.services)).not.toContain('www-ssl');
    expect(achados.map((a) => a.command).join('\n')).not.toContain('www-ssl');
  });

  test('apanha os que levam credenciais em texto simples', () => {
    const findings = auditRouterServices([
      ...fechado.filter((s) => !['ftp', 'telnet', 'www', 'api'].includes(s.name)),
      service({ name: 'ftp', port: 21 }),
      service({ name: 'telnet', port: 23 }),
      service({ name: 'www', port: 80 }),
      service({ name: 'api', port: 8728 })
    ]);
    const claro = findings.find((f) => f.severity === 'grave');
    expect(claro?.services.sort()).toEqual(['api', 'ftp', 'telnet', 'www']);
    expect(claro?.command).toBe('/ip service disable ftp,telnet,www,api');
  });

  test('o www conta como texto simples — a REST também responde nele', () => {
    const findings = auditRouterServices([service({ name: 'www', port: 80 })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].services).toEqual(['www']);
  });

  test('um serviço ssl sem certificado está ligado a fingir', () => {
    const semCert = auditRouterServices([service({ name: 'api-ssl', port: 8729 })]);
    expect(semCert.map((f) => f.services)).toEqual([['api-ssl']]);

    const comCert = auditRouterServices([service({ name: 'api-ssl', port: 8729, certificate: 'algum' })]);
    expect(comCert).toEqual([]);
  });

  test('o www-ssl com certificado nunca é sinalizado — é onde a REST vive', () => {
    expect(auditRouterServices([service({ name: 'www-ssl', port: 443, certificate: 'ispm-cert' })])).toEqual([]);
  });

  test('winbox e ssh sem restrição são aviso, com restrição não são nada', () => {
    const aberto = auditRouterServices([
      service({ name: 'winbox', port: 8291 }),
      service({ name: 'ssh', port: 22 })
    ]);
    expect(aberto).toHaveLength(1);
    expect(aberto[0].severity).toBe('aviso');
    expect(aberto[0].services.sort()).toEqual(['ssh', 'winbox']);

    expect(auditRouterServices([service({ name: 'winbox', port: 8291, address: '10.0.0.0/8' })])).toEqual([]);
  });

  test('o discover nunca é sinalizado: é dele que vem o modelo dos equipamentos', () => {
    // Desligá-lo cega a descoberta (listNeighbors). Este teste existe para o
    // dia em que alguém achar que o 5678 aberto é supérfluo.
    const findings = auditRouterServices([service({ name: 'discover', port: 5678 })]);
    expect(findings).toEqual([]);
  });

  test('o btest e aviso: nao vaza senha, mas deixa saturar o router', () => {
    const findings = auditRouterServices([service({ name: 'btest', port: 2000 })]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('aviso');
    expect(findings[0].command).toBe('/ip service disable btest');
  });

  test('o RouterOS 7.24 lista o winbox duas vezes: o achado e o comando dizem-no uma vez só', () => {
    const findings = auditRouterServices([
      service({ name: 'ssh', port: 22 }),
      service({ name: 'winbox', port: 8291 }),
      service({ name: 'winbox', port: 8291 })
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].services).toEqual(['ssh', 'winbox']);
    expect(findings[0].command.split('\n')).toHaveLength(2);
  });

  test('um serviço desligado não conta, mesmo sendo dos perigosos', () => {
    expect(auditRouterServices([service({ name: 'telnet', port: 23, disabled: true })])).toEqual([]);
  });
});

describe('leituras do módulo Router de gestão', () => {
  test('readSystem junta recurso e identidade e converte números do RouterOS', async () => {
    const transport = fakeTransport([
      [{
        version: '7.24.2 (stable)',
        'board-name': 'hEX S',
        uptime: '3d4h12m',
        'cpu-load': '7',
        'free-memory': '200278016',
        'total-memory': '268435456',
        'architecture-name': 'mmips'
      }],
      { name: 'ISP-Gestao' }
    ]);
    await expect(readSystem(transport)).resolves.toEqual({
      identity: 'ISP-Gestao',
      version: '7.24.2 (stable)',
      boardName: 'hEX S',
      architecture: 'mmips',
      uptime: '3d4h12m',
      cpuLoad: 7,
      freeMemory: 200278016,
      totalMemory: 268435456
    });
    expect(transport.calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(transport.calls[1].path).toBe('/system/identity');
  });

  test('readSystem não inventa números que o router não deu', async () => {
    const transport = fakeTransport([[{}], {}]);
    await expect(readSystem(transport)).resolves.toMatchObject({
      identity: null,
      cpuLoad: null,
      freeMemory: null,
      totalMemory: null
    });
  });

  test('listInterfaces lê só o que se mostra e normaliza booleanos e contadores', async () => {
    const transport = fakeTransport([[
      { name: 'ether1', type: 'ether', running: 'true', disabled: 'false', 'mac-address': '48:A9:8A:00:00:01', 'rx-byte': '1024', 'tx-byte': '2048', comment: 'WAN Starlink' },
      { name: 'pppoe-in1', type: 'pppoe-in', running: 'true', disabled: 'false' },
      { type: 'ether' }
    ]]);
    await expect(listInterfaces(transport)).resolves.toEqual([
      { name: 'ether1', type: 'ether', running: true, disabled: false, macAddress: '48:A9:8A:00:00:01', rxBytes: 1024, txBytes: 2048, comment: 'WAN Starlink' },
      { name: 'pppoe-in1', type: 'pppoe-in', running: true, disabled: false, macAddress: null, rxBytes: null, txBytes: null, comment: null }
    ]);
    expect(transport.calls[0]).toEqual({
      method: 'GET',
      path: '/interface?.proplist=name,type,running,disabled,mac-address,rx-byte,tx-byte,comment'
    });
  });

  test('listInterfaceListMembers lê os membros da lista pedida', async () => {
    const transport = fakeTransport([[{ interface: 'WAN1-STARLINK' }, { interface: 'WAN2-STARLINK' }, {}]]);
    await expect(listInterfaceListMembers(transport, 'WAN')).resolves.toEqual(['WAN1-STARLINK', 'WAN2-STARLINK']);
    expect(transport.calls[0]).toEqual({ method: 'GET', path: '/interface/list/member?list=WAN&.proplist=interface' });
  });

  test('monitorTraffic lê as taxas medidas pelo router sem inventar valores ausentes', async () => {
    const transport = fakeTransport([[
      { name: 'WAN1-STARLINK', 'rx-bits-per-second': '10000000', 'tx-bits-per-second': '1000000' },
      { name: 'WAN2-STARLINK', 'rx-bits-per-second': '5000000' }
    ]]);
    await expect(monitorTraffic(transport, ['WAN1-STARLINK', 'WAN2-STARLINK'])).resolves.toEqual([
      { name: 'WAN1-STARLINK', rxBps: 10_000_000, txBps: 1_000_000 },
      { name: 'WAN2-STARLINK', rxBps: 5_000_000, txBps: null }
    ]);
    expect(transport.calls[0]).toEqual({
      method: 'POST',
      path: '/interface/monitor-traffic',
      body: { interface: 'WAN1-STARLINK,WAN2-STARLINK', once: '' }
    });
  });

  test('listLog devolve o registo todo, as mais recentes primeiro, e ignora linhas vazias', async () => {
    const transport = fakeTransport([[
      { '.id': '*1', time: '2026-09-25 23:59:01', topics: 'system,info', message: 'router rebooted' },
      { '.id': '*2', time: '02:40:13', topics: 'system,error,critical', message: 'login failure for user admin from 10.0.0.9 via winbox' },
      { '.id': '*3', time: '02:41:00', topics: 'pppoe,info' }
    ]]);
    await expect(listLog(transport)).resolves.toEqual([
      { id: '*2', time: '02:40:13', topics: 'system,error,critical', message: 'login failure for user admin from 10.0.0.9 via winbox' },
      { id: '*1', time: '2026-09-25 23:59:01', topics: 'system,info', message: 'router rebooted' }
    ]);
    expect(transport.calls[0]).toEqual({ method: 'GET', path: '/log?buffer=memory&.proplist=.id,time,topics,message' });
  });

  // Linhas do registo real do hEX S (RouterOS 7.24.2), exportado a 2026-09-26.
  const line = (message: string) => ({ id: '*1', time: '', topics: '', message });

  test('summarizeLog agrupa as falhas de login por origem e serviço, pior primeiro', () => {
    const { loginFailures } = summarizeLog([
      line('login failure for user admin from 10.0.0.9 via winbox'),
      line('login failure for user root from 10.0.0.9 via ssh'),
      line('login failure for user ubnt from 10.0.0.9 via ssh'),
      line('login failure for user root from 10.0.0.9 via ssh'),
      line('user admin logged in from 192.168.2.250 via winbox')
    ]);
    expect(loginFailures).toEqual([
      { address: '10.0.0.9', via: 'ssh', users: ['root', 'ubnt'], count: 3 },
      { address: '10.0.0.9', via: 'winbox', users: ['admin'], count: 1 }
    ]);
  });

  test('summarizeLog aponta o servidor DHCP intruso travado pelo snooping, por MAC', () => {
    const intruder = 'LAN1: received DHCP server message on untrusted port from source IP 192.168.0.1, MAC 30:16:9d:aa:53:8b';
    const { rogueDhcp } = summarizeLog([
      line(intruder),
      line(intruder),
      line('LAN1: received DHCP server message on untrusted port from source IP 192.168.0.254, MAC 18:69:45:23:68:04')
    ]);
    expect(rogueDhcp).toEqual([
      { port: 'LAN1', address: '192.168.0.1', mac: '30:16:9D:AA:53:8B', count: 2 },
      { port: 'LAN1', address: '192.168.0.254', mac: '18:69:45:23:68:04', count: 1 }
    ]);
  });

  test('summarizeLog conta as quedas de PPPoE por utilizador, com os motivos', () => {
    const { pppoeDrops } = summarizeLog([
      line('<pppoe-skn001>: terminating... - peer is not responding'),
      line('<pppoe-skn001>: terminating... - peer is not responding'),
      line('<pppoe-skn001>: terminating... - hungup '),
      line('skn001 logged out, 3551 1846177 2860783 13155 13532 from 18:FD:74:22:23:B7'),
      line('<pppoe-skn001>: disconnected ')
    ]);
    expect(pppoeDrops).toEqual([{ login: 'skn001', reasons: ['peer is not responding', 'hungup'], count: 3 }]);
  });

  test('summarizeLog só marca como ciclo de DHCP a partir do limiar', () => {
    const camera = 'dhcp-SKYNET deassigned 192.168.2.97 for 90:6A:94:F7:DE:11 NOMI-IPC-S7X-10M0WED-ECE2';
    const entries = [
      ...Array.from({ length: DHCP_CHURN_THRESHOLD }, () => line(camera)),
      line('dhcp-SKYNET deassigned 192.168.2.60 for 5C:E9:1E:00:00:01 Redmi-Note-9'),
      line('dhcp-SKYNET deassigned 192.168.2.61 for 5C:E9:1E:00:00:02')
    ];
    expect(summarizeLog(entries).dhcpChurn).toEqual([
      { mac: '90:6A:94:F7:DE:11', address: '192.168.2.97', hostname: 'NOMI-IPC-S7X-10M0WED-ECE2', count: DHCP_CHURN_THRESHOLD }
    ]);
    expect(summarizeLog([])).toEqual({ loginFailures: [], rogueDhcp: [], pppoeDrops: [], dhcpChurn: [] });
  });
});

describe('blindagem para lá dos serviços', () => {
  const rule = (partial: Partial<RouterFirewallRule>): RouterFirewallRule => ({
    action: 'drop', protocol: null, dstPort: null, inInterface: null, inInterfaceList: null, connectionState: null, disabled: false, ...partial
  });
  const closed: RouterHardening = {
    dnsRemote: true,
    inputRules: [rule({ connectionState: 'invalid' }), rule({ inInterfaceList: '!LAN' })],
    bridges: [{ name: 'bridge-LAN', dhcpSnooping: true }],
    macWinboxList: 'LAN'
  };

  test('router fechado: nada a dizer', () => {
    expect(auditRouterHardening(closed)).toEqual([]);
    expect(auditRouterHardening({ ...closed, inputRules: [rule({ inInterfaceList: 'WAN', protocol: 'udp', dstPort: '22,53-54' })] })).toEqual([]);
  });

  test('DNS aberto à WAN, bridge sem snooping e WinBox por MAC em todas as portas', () => {
    const findings = auditRouterHardening({
      dnsRemote: true,
      // Um drop sem interface fecha a LAN também e não conta; um drop só a inválidas não fecha nada.
      inputRules: [rule({ connectionState: 'invalid' }), rule({ protocol: 'udp', dstPort: '53' }), rule({ inInterfaceList: 'WAN', disabled: true })],
      bridges: [{ name: 'bridge-LAN', dhcpSnooping: false }],
      macWinboxList: 'all'
    });
    expect(findings.map((finding) => [finding.services, finding.severity])).toEqual([
      [['dns'], 'grave'], [['bridge-LAN'], 'aviso'], [['mac-winbox'], 'aviso']
    ]);
    expect(findings[0].command).toContain('dst-port=53');
  });

  test('o que não se conseguiu ler não acusa nada', () => {
    expect(auditRouterHardening({ dnsRemote: null, inputRules: null, bridges: null, macWinboxList: null })).toEqual([]);
    expect(auditRouterHardening({ ...closed, inputRules: null })).toEqual([]);
  });

  test('lê o DNS, a cadeia de entrada, as bridges e o WinBox por MAC só com GETs', async () => {
    const asked: string[] = [];
    const state = await readRouterHardening(async ({ method, path }) => {
      asked.push(`${method} ${path.split('?')[0]}`);
      if (path.startsWith('/ip/dns')) return { 'allow-remote-requests': 'true' };
      if (path.startsWith('/ip/firewall')) return [{ action: 'drop', 'in-interface-list': 'WAN', disabled: 'false' }];
      if (path.startsWith('/interface/bridge')) return [{ name: 'bridge-LAN', 'dhcp-snooping': 'true' }, { name: 'velha', disabled: 'true' }];
      throw new Error('sem permissão');
    });
    expect(asked.every((line) => line.startsWith('GET '))).toBe(true);
    expect(state).toEqual({
      dnsRemote: true,
      inputRules: [rule({ inInterfaceList: 'WAN' })],
      bridges: [{ name: 'bridge-LAN', dhcpSnooping: true }],
      macWinboxList: null
    });
  });

  test('PPPoE fora do ISPM e perfis sem limite em uso (19/10/2026)', () => {
    const secret = (name: string, profile: string | null, disabled = false) => ({ id: `*${name}`, name, profile, disabled, comment: null });
    const secrets = [secret('admin', 'ULTRA'), secret('skn001', 'ispm-plano-1'), secret('velho', 'default', true), secret('skn009', 'SUSPENSO')];
    const findings = auditPppAccess([secrets[0]], secrets, [
      { name: 'ULTRA', rateLimit: null }, { name: 'ispm-plano-1', rateLimit: '10M/40M' }, { name: 'default', rateLimit: null }, { name: 'SUSPENSO', rateLimit: null }
    ], ['SUSPENSO']);
    expect(findings.map((finding) => finding.services)).toEqual([['admin'], ['ULTRA']]);
    // O `.id` destes secrets de teste não tem o feitio do RouterOS: cai no nome, entre aspas.
    expect(findings[0].command).toBe('/ppp secret disable [find name="admin"]');
  });

  test('um perfil sem limite usado só pelo acesso interno do ISP não é apontado; com um cliente nele, é', () => {
    const internal = { id: '*7', name: 'gestao-arydson', profile: 'ULTRA', disabled: false, comment: 'ispm-interno: router do Arydson' };
    const client = { id: '*8', name: 'skn030', profile: 'ULTRA', disabled: false, comment: 'ispm:30 Ana' };
    const profiles = [{ name: 'ULTRA', rateLimit: null }];
    // A marca não esconde: o acesso interno fica à vista como informação, com o comando para o desligar.
    expect(auditPppAccess([], [internal], profiles)).toEqual([expect.objectContaining({
      services: ['gestao-arydson'], severity: 'info', command: '/ppp secret disable *7'
    })]);
    expect(auditPppAccess([], [internal, client], profiles).map((finding) => [finding.services, finding.severity]))
      .toEqual([[['gestao-arydson'], 'info'], [['ULTRA'], 'aviso']]);
  });

  test('nomes vindos do router não injetam comandos no que o operador cola no terminal', () => {
    const evil = 'x"]; /system reset-configuration; :put "';
    const [secretFinding] = auditPppAccess([{ id: '*1D', name: evil, profile: null, disabled: false, comment: null }], [], []);
    expect(secretFinding.command).toBe('/ppp secret disable *1D');
    const [bridgeFinding] = auditRouterHardening({ dnsRemote: null, inputRules: null, bridges: [{ name: `br"; /system reboot\n$x`, dhcpSnooping: false }], macWinboxList: null });
    expect(bridgeFinding.command).toBe('/interface bridge set [find name="br\\"; /system reboot\\$x"] dhcp-snooping=yes');
    expect(rosQuote('a\\b')).toBe('"a\\\\b"');
  });
});

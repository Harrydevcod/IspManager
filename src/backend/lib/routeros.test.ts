import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  auditRouterServices,
  createProfile,
  createSecret,
  describeRouterFailure,
  listProfiles,
  patchProfile,
  diagnoseRouter,
  isRouterConfigured,
  listActive,
  listSecrets,
  patchSecret,
  readRouterConfig,
  removeActive,
  RouterError,
  testConnection,
  readSystem,
  listInterfaces,
  type RouterRequest,
  type RouterService,
  listArp,
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

  test('listProfiles normaliza os perfis e descarta linhas sem id', async () => {
    const transport = fakeTransport([
      [
        { '.id': '*0', name: 'default', 'local-address': '10.10.0.1', 'remote-address': 'pool-clientes', 'dns-server': '1.1.1.1', 'only-one': 'yes' },
        { '.id': '*A', name: 'plano-20M', 'rate-limit': '20M/20M', comment: 'ispm:plano:1' },
        { name: 'sem-id' }
      ]
    ]);
    await expect(listProfiles(transport)).resolves.toEqual([
      { id: '*0', name: 'default', rateLimit: null, localAddress: '10.10.0.1', remoteAddress: 'pool-clientes', dnsServer: '1.1.1.1', onlyOne: 'yes', comment: null },
      { id: '*A', name: 'plano-20M', rateLimit: '20M/20M', localAddress: null, remoteAddress: null, dnsServer: null, onlyOne: null, comment: 'ispm:plano:1' }
    ]);
    expect(transport.calls[0]).toEqual({
      method: 'GET',
      path: '/ppp/profile?.proplist=.id,name,rate-limit,local-address,remote-address,dns-server,only-one,comment'
    });
  });

  test('createProfile copia os endereços do perfil-base e junta o limite e a marca', async () => {
    const transport = fakeTransport([{ '.id': '*B' }]);
    const id = await createProfile(transport, {
      name: 'plano-20M',
      rateLimit: '20M/20M',
      comment: 'ispm:plano:1',
      base: { id: '*0', name: 'default', rateLimit: null, localAddress: '10.10.0.1', remoteAddress: 'pool-clientes', dnsServer: null, onlyOne: 'yes', comment: null }
    });
    expect(id).toBe('*B');
    // O que o base não tem não se envia: o RouterOS fica com a omissão dele.
    expect(transport.calls[0]).toEqual({
      method: 'PUT',
      path: '/ppp/profile',
      body: {
        name: 'plano-20M',
        'rate-limit': '20M/20M',
        comment: 'ispm:plano:1',
        'local-address': '10.10.0.1',
        'remote-address': 'pool-clientes',
        'only-one': 'yes'
      }
    });
  });

  test('patchProfile só mexe no limite', async () => {
    const transport = fakeTransport([null]);
    await patchProfile(transport, '*B', { rateLimit: '30M/30M' });
    expect(transport.calls[0]).toEqual({ method: 'PATCH', path: '/ppp/profile/*B', body: { 'rate-limit': '30M/30M' } });
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
});

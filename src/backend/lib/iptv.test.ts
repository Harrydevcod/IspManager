import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import type { RouterRequest, RouterTransport } from './routeros';
import { canonicalHost, HOST, loadIptvTargets, syncIptv } from './iptv';

function seed() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO clients (id, client_code, full_name, status) VALUES (101,'C0014','Chia','active'),(102,'C0020','Gemada','active')`).run();
  db.prepare(`INSERT INTO equipment_catalog (id, type, model) VALUES (901,'cpe','CPE'),(902,'router','Router')`).run();
  db.prepare(`INSERT INTO services (id, client_id, monthly_value_cve, status, pppoe_username, iptv_vpn) VALUES (1,101,2500,'active','skn014',1),(2,102,2500,'active',NULL,1),(3,101,2500,'active','skn099',0)`).run();
  db.prepare(`INSERT INTO service_device_assignments (service_id, catalog_id, mac_address, operation_mode, start_date) VALUES (2,901,'0C:EF:15:90:D6:40','cliente','2026-01-01'),(2,902,'BC:07:1D:5E:54:E7','router','2026-01-01')`).run();
  db.prepare(`INSERT INTO iptv_providers (id, name, hosts) VALUES (1,'Dino','line.dino.ws\n1.2.3.4')`).run();
  return db;
}

function router(existing: Record<string, unknown>[] = []) {
  const calls: RouterRequest[] = [];
  const list = [...existing];
  const transport: RouterTransport = async (request) => {
    calls.push(request);
    if (request.path.startsWith('/ip/firewall/address-list?')) return list;
    if (request.method === 'GET' && request.path.startsWith('/system/script?name=')) return [{ source: '# x', invalid: 'false' }];
    if (request.method === 'GET') return [];
    return null;
  };
  return { transport, calls };
}

describe('IPTV via VPN', () => {
  test('alvos: utilizador PPPoE ou MAC pela regra, só serviços activos e marcados', () => {
    const targets = loadIptvTargets(seed());
    expect(targets.map((t) => [t.serviceId, t.source])).toEqual([
      [1, { kind: 'pppoe', username: 'skn014', legacy: null }],
      [2, { kind: 'mac', mac: 'BC:07:1D:5E:54:E7', via: 'router' }]
    ]);
  });

  test('cliente em migração: o script leva o utilizador e o MAC legacy', async () => {
    const db = seed();
    db.prepare(`UPDATE services SET pppoe_username = 'skn020' WHERE id = 2`).run();
    const { transport } = router();
    expect(await syncIptv(db, { transport, dryRun: true })).toMatchObject({ users: ['skn014', 'skn020'], macs: ['BC:07:1D:5E:54:E7'] });
  });

  test('diz por onde cada cliente está a entrar e aponta a entrada manual obsoleta', async () => {
    const db = seed();
    db.prepare(`UPDATE services SET pppoe_username = 'skn020' WHERE id = 2`).run();
    const transport: RouterTransport = async (request) => {
      if (request.path.startsWith('/ip/firewall/address-list?list=IPTV-SPLIT')) return [{ '.id': '*M', address: '192.168.2.226', comment: 'Cliente-Gemada TP-Link', dynamic: 'false' }];
      if (request.path.startsWith('/ppp/active')) return [{ '.id': '*1', name: 'skn020', address: '10.20.0.9' }];
      return [];
    };
    const result = await syncIptv(db, { transport, dryRun: true });
    expect(result).toMatchObject({
      active: [{ serviceId: 1, via: null }, { serviceId: 2, via: 'pppoe', address: '10.20.0.9' }],
      unownedManual: [{ address: '192.168.2.226', comment: 'Cliente-Gemada TP-Link' }]
    });
  });

  test('em ensaio não escreve nada e diz o que faria', async () => {
    const { transport, calls } = router();
    const result = await syncIptv(seed(), { transport, dryRun: true });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(result).toMatchObject({ status: 'dry_run', users: ['skn014'], macs: ['BC:07:1D:5E:54:E7'] });
  });

  test('em efectivo instala o script, corre-o e sincroniza os servidores só pelo comentário do ISPM', async () => {
    const { transport, calls } = router([
      { '.id': '*A', address: 'line.dino.ws', comment: 'Fornecedor Gemada - portal', dynamic: 'false' },
      { '.id': '*B', address: '9.9.9.9', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false' }
    ]);
    const db = seed();
    await syncIptv(db, { transport, dryRun: false });
    const audit = db.prepare("SELECT actor_username AS actor, metadata_json AS meta FROM audit_logs WHERE action = 'iptv_vpn_sync'").get() as { actor: string; meta: string };
    expect(audit.actor).toBe('sistema');
    expect(JSON.parse(audit.meta)).toMatchObject({ before: null, after: { users: ['skn014'] } });
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/system/script')).toBe(true);
    expect(calls).toContainEqual({ method: 'POST', path: '/system/script/run', body: { '.id': 'ispm-iptv' } });
    const writes = calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET');
    expect(writes).toEqual([
      { method: 'PUT', path: '/ip/firewall/address-list', body: { list: 'IPTV-SERVERS', address: '1.2.3.4', comment: 'ispm-iptv-srv:1 Dino' } },
      { method: 'DELETE', path: '/ip/firewall/address-list/*B' }
    ]);
    expect(await syncIptv(seed(), { transport: router([{ '.id': '*A', address: 'Line.Dino.ws', comment: 'manual', dynamic: 'false' }]).transport, dryRun: true }))
      .toMatchObject({ serversCovered: [{ address: 'line.dino.ws', comment: 'manual', disabled: false }] });
    expect(JSON.parse((db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'iptv_vpn_servers'").get() as { m: string }).m)).toEqual({ added: ['1.2.3.4'], removed: ['9.9.9.9'], renamed: [], reactivated: [] });
    // A entrada manual *A nunca é tocada.
    expect(writes.some((c) => c.path.endsWith('*A'))).toBe(false);
  });

  test('entrada manual com o endereço de um alvo é reportada, nunca tocada', async () => {
    const calls: RouterRequest[] = [];
    const transport: RouterTransport = async (request) => {
      calls.push(request);
      if (request.path.startsWith('/ip/firewall/address-list?list=IPTV-SPLIT')) return [{ '.id': '*M', address: '192.168.2.226', comment: 'Cliente-Gemada TP-Link', dynamic: 'false' }];
      if (request.path.startsWith('/ip/dhcp-server/lease')) return [{ address: '192.168.2.226', 'mac-address': 'BC:07:1D:5E:54:E7', status: 'bound' }];
      return [];
    };
    const result = await syncIptv(seed(), { transport, dryRun: true });
    expect(result).toMatchObject({ manualConflicts: [{ address: '192.168.2.226', comment: 'Cliente-Gemada TP-Link' }] });
    expect(calls.some((c) => c.path.includes('*M') && c.method !== 'GET')).toBe(false);
  });

  test('lease estática em waiting não torna a entrada manual sem dono', async () => {
    const transport: RouterTransport = async (request) => {
      if (request.path.startsWith('/ip/firewall/address-list?list=IPTV-SPLIT')) return [{ '.id': '*M', address: '192.168.2.50', comment: 'TV', dynamic: 'false' }];
      if (request.path.startsWith('/ip/dhcp-server/lease')) return [{ address: '192.168.2.50', 'mac-address': 'AA:AA:AA:AA:AA:01', status: 'waiting' }];
      return [];
    };
    expect(await syncIptv(seed(), { transport, dryRun: true })).toMatchObject({ unownedManual: [], foreignManual: [] });
  });

  test('entrada manual cujo endereço passou para outro MAC é reportada como alheia', async () => {
    const transport: RouterTransport = async (request) => {
      if (request.path.startsWith('/ip/firewall/address-list?list=IPTV-SPLIT')) return [{ '.id': '*M', address: '192.168.2.226', comment: 'velho', dynamic: 'false' }];
      if (request.path.startsWith('/ip/dhcp-server/lease')) return [{ address: '192.168.2.226', 'mac-address': 'aa:bb:cc:dd:ee:ff', status: 'bound' }];
      return [];
    };
    expect(await syncIptv(seed(), { transport, dryRun: true })).toMatchObject({ foreignManual: [{ address: '192.168.2.226', comment: 'velho', holder: 'AA:BB:CC:DD:EE:FF' }] });
  });

  test('dois fornecedores com o mesmo host: só o primeiro fica com a entrada', async () => {
    const db = seed();
    db.prepare("INSERT INTO iptv_providers (id, name, hosts) VALUES (2, 'Outro', 'LINE.dino.ws')").run();
    const { transport, calls } = router();
    await syncIptv(db, { transport, dryRun: false });
    const adds = calls.filter((c) => c.method === 'PUT' && c.path === '/ip/firewall/address-list').map((c) => (c.body as { address: string }).address);
    expect(adds.sort()).toEqual(['1.2.3.4', 'line.dino.ws']);
  });

  test('IPv4 com octeto acima de 255 é ignorado', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = '999.1.1.1\n8.8.8.8/24'").run();
    expect(HOST.test('999.1.1.1')).toBe(false);
    expect(HOST.test('8.8.8.8/33')).toBe(false);
    const { transport, calls } = router();
    await syncIptv(db, { transport, dryRun: false });
    const adds = calls.filter((c) => c.method === 'PUT' && c.path === '/ip/firewall/address-list').map((c) => (c.body as { address: string }).address);
    expect(adds).toEqual(['8.8.8.0/24']);
  });

  test('forma canónica: /32 sem prefixo, bits de host a zero, /0, domínio em minúsculas', () => {
    expect(canonicalHost('8.8.8.8/32')).toBe('8.8.8.8');
    expect(canonicalHost('8.8.8.8/24')).toBe('8.8.8.0/24');
    expect(canonicalHost('8.8.8.8/0')).toBe('0.0.0.0/0');
    expect(canonicalHost('1.2.3.4')).toBe('1.2.3.4');
    expect(canonicalHost('Line.Dino.WS')).toBe('line.dino.ws');
    expect(canonicalHost('999.1.1.1')).toBeNull();
    expect(canonicalHost('8.8.8.8/33')).toBeNull();
    expect(canonicalHost('a/b.com')).toBeNull();
  });

  test('o router guarda 8.8.8.0/24: a entrada canónica não é recriada', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = '8.8.8.8/24'").run();
    const { transport, calls } = router([{ '.id': '*D', address: '8.8.8.0/24', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false' }]);
    await syncIptv(db, { transport, dryRun: false });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([]);
  });

  test('fornecedor renomeado: PATCH do comentário, sem apagar nem recriar', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET name = 'Novo', hosts = 'line.dino.ws'").run();
    const { transport, calls } = router([{ '.id': '*C', address: 'line.dino.ws', comment: 'ispm-iptv-srv:1 Velho', dynamic: 'false' }]);
    const result = await syncIptv(db, { transport, dryRun: false });
    expect(result).toMatchObject({ servers: { added: 0, removed: 0, renamed: 1 } });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/ip/firewall/address-list/*C', body: { comment: 'ispm-iptv-srv:1 Novo' } }
    ]);
    expect(JSON.parse((db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'iptv_vpn_servers'").get() as { m: string }).m))
      .toMatchObject({ added: [], removed: [], renamed: ['line.dino.ws'] });
  });

  test('host que passa do fornecedor 1 para o 2: PATCH com o comentário do 2', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = '1.2.3.4'").run();
    db.prepare("INSERT INTO iptv_providers (id, name, hosts) VALUES (2, 'Outro', 'line.dino.ws')").run();
    const { transport, calls } = router([
      { '.id': '*C', address: 'line.dino.ws', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false' },
      { '.id': '*E', address: '1.2.3.4', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false' }
    ]);
    await syncIptv(db, { transport, dryRun: false });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/ip/firewall/address-list/*C', body: { comment: 'ispm-iptv-srv:2 Outro' } }
    ]);
  });

  test.each(['Dino', 'Velho'])('entrada própria desactivada (%s): ensaio prevê a reactivação; efectivo aplica e audita por .id', async (name) => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = 'line.dino.ws'").run();
    const { transport, calls } = router([
      { '.id': '*C', address: 'line.dino.ws', comment: `ispm-iptv-srv:1 ${name}`, dynamic: 'false', disabled: 'true' }
    ]);
    const changes = { added: 0, removed: 0, renamed: name === 'Dino' ? 0 : 1, reactivated: 1 };
    expect(await syncIptv(db, { transport, dryRun: true })).toMatchObject({ status: 'dry_run', servers: changes });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'iptv_vpn_servers'").get()).toEqual({ n: 0 });

    expect(await syncIptv(db, { transport, dryRun: false })).toMatchObject({ status: 'applied', servers: changes });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([
      { method: 'PATCH', path: '/ip/firewall/address-list/*C', body: { ...(name === 'Dino' ? {} : { comment: 'ispm-iptv-srv:1 Dino' }), disabled: 'no' } }
    ]);
    expect(JSON.parse((db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'iptv_vpn_servers'").get() as { m: string }).m))
      .toEqual({ added: [], removed: [], renamed: name === 'Dino' ? [] : ['line.dino.ws'], reactivated: ['line.dino.ws'] });
  });

  test('entrada manual desactivada nunca é reactivada pelo ISPM', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = 'line.dino.ws'").run();
    const { transport, calls } = router([
      { '.id': '*M', address: 'line.dino.ws', comment: 'manual', dynamic: 'false', disabled: 'true' }
    ]);
    expect(await syncIptv(db, { transport, dryRun: false })).toMatchObject({
      servers: { added: 0, removed: 0, renamed: 0, reactivated: 0 },
      serversCovered: [{ address: 'line.dino.ws', comment: 'manual', disabled: true }]
    });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([]);
  });

  test('reactivação interrompida audita só as entradas que chegaram a ser reactivadas', async () => {
    const db = seed();
    const recorded = router([
      { '.id': '*A', address: '1.2.3.4', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false', disabled: 'true' },
      { '.id': '*B', address: 'line.dino.ws', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false', disabled: 'true' }
    ]);
    const transport: RouterTransport = async (request) => {
      if (request.method === 'PATCH' && request.path.endsWith('/*B')) throw new Error('router caiu');
      return recorded.transport(request);
    };
    await expect(syncIptv(db, { transport, dryRun: false })).rejects.toThrow('router caiu');
    expect(JSON.parse((db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'iptv_vpn_servers'").get() as { m: string }).m))
      .toEqual({ added: [], removed: [], renamed: [], reactivated: ['1.2.3.4'] });
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'iptvVpnApplied'").get()).toBeUndefined();
  });

  test('uma escrita que falha a meio: o registo dos servidores guarda o que ficou escrito e o erro propaga', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = '1.2.3.4\n5.6.7.8'").run();
    let puts = 0;
    const transport: RouterTransport = async (request) => {
      if (request.method === 'PUT' && request.path === '/ip/firewall/address-list' && ++puts === 2) throw new Error('router caiu');
      return [];
    };
    await expect(syncIptv(db, { transport, dryRun: false })).rejects.toThrow('router caiu');
    expect(JSON.parse((db.prepare("SELECT metadata_json AS m FROM audit_logs WHERE action = 'iptv_vpn_servers'").get() as { m: string }).m))
      .toMatchObject({ added: ['1.2.3.4'] });
  });

  test('lease bound sem MAC cai para a sessão PPPoE do mesmo endereço', async () => {
    const transport: RouterTransport = async (request) => {
      if (request.path.startsWith('/ip/firewall/address-list?list=IPTV-SPLIT')) return [{ '.id': '*M', address: '10.20.0.77', comment: 'x', dynamic: 'false' }];
      if (request.path.startsWith('/ip/dhcp-server/lease')) return [{ address: '10.20.0.77', status: 'bound' }];
      if (request.path.startsWith('/ppp/active')) return [{ '.id': '*9', name: 'skn077', address: '10.20.0.77' }];
      return [];
    };
    expect(await syncIptv(seed(), { transport, dryRun: true })).toMatchObject({ foreignManual: [{ address: '10.20.0.77', holder: 'skn077' }] });
  });

  test('valor aplicado corrompido conta como nunca aplicado', async () => {
    const db = seed();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('iptvVpnApplied', '{x')").run();
    const { transport } = router();
    expect(await syncIptv(db, { transport, dryRun: true })).toMatchObject({ before: null });
  });

  test('utilizador renomeado no router fica de fora, com a razão', () => {
    const db = seed();
    db.prepare(`INSERT INTO service_network_state (service_id, divergence) VALUES (1, 'username')`).run();
    expect(loadIptvTargets(db)[0]).toEqual({ serviceId: 1, source: { kind: 'missing', reason: 'Utilizador diferente no router: resolva na Reconciliação' } });
  });

  test('domínios em maiúsculas no router não geram adicionar e remover repetidos', async () => {
    const db = seed();
    db.prepare("UPDATE iptv_providers SET hosts = 'Line.Dino.WS'").run();
    const { transport, calls } = router([{ '.id': '*B', address: 'LINE.dino.ws', comment: 'ispm-iptv-srv:1 Dino', dynamic: 'false' }]);
    await syncIptv(db, { transport, dryRun: false });
    expect(calls.filter((c) => c.path.startsWith('/ip/firewall/address-list') && c.method !== 'GET')).toEqual([]);
  });

  test('sem nenhum serviço marcado e sem script instalado, não instala nada', async () => {
    const db = seed();
    db.prepare('UPDATE services SET iptv_vpn = 0').run();
    db.prepare('DELETE FROM iptv_providers').run();
    const { transport, calls } = router();
    expect(await syncIptv(db, { transport, dryRun: false })).toMatchObject({ status: 'idle' });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import type { RouterRequest, RouterTransport } from './routeros';
import { loadIptvTargets, syncIptv } from './iptv';

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
      staleManual: [{ address: '192.168.2.226', comment: 'Cliente-Gemada TP-Link' }]
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
      { method: 'PUT', path: '/ip/firewall/address-list', body: { list: 'IPTV-SERVERS', address: 'line.dino.ws', comment: 'ispm-iptv-srv:1 Dino' } },
      { method: 'DELETE', path: '/ip/firewall/address-list/*B' }
    ]);
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

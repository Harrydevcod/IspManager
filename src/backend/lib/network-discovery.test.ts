import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  loadRegisteredDevices,
  loadSeenHosts,
  normalizeMac,
  parseArpTable,
  persistModel,
  persistSeen,
  sweep,
  vendorForMac,
  type DiscoveredHost
} from './network-discovery';
import type { Pinger } from './network-probe';

// ------------------------------------------------------------------ ARP

// Output real do `arp -a` do Windows em português — é esta a máquina em que a
// aplicação corre, e é aqui que um parser dependente de cabeçalhos falharia.
const ARP_WINDOWS_PT = `
Interface: 192.168.1.10 --- 0xd
  Endereço Internet      Endereço Físico       Tipo
  192.168.1.1           a4-2b-b0-11-22-33     dinâmico
  192.168.1.42          50-c7-bf-aa-bb-cc     dinâmico
  192.168.1.255         ff-ff-ff-ff-ff-ff     estático
  224.0.0.22            01-00-5e-00-00-16     estático
  239.255.255.250       01-00-5e-7f-ff-fa     estático
`;

const ARP_WINDOWS_EN = `
Interface: 10.0.0.5 --- 0x4
  Internet Address      Physical Address      Type
  10.0.0.1              00-0c-42-de-ad-be     dynamic
  10.0.0.9              b8-27-eb-01-02-03     dynamic
`;

const ARP_LINUX = `
? (192.168.88.1) at cc:2d:e0:11:22:33 [ether] on eth0
? (192.168.88.20) at f0:9f:c2:aa:bb:cc [ether] on eth0
? (192.168.88.99) at <incomplete> on eth0
`;

describe('parseArpTable', () => {
  test('Windows pt-PT — apanha os equipamentos e descarta grupo', () => {
    expect(parseArpTable(ARP_WINDOWS_PT)).toEqual([
      { ip: '192.168.1.1', mac: 'A4:2B:B0:11:22:33' },
      { ip: '192.168.1.42', mac: '50:C7:BF:AA:BB:CC' }
    ]);
  });

  test('Windows EN dá o mesmo resultado — o parser não lê cabeçalhos', () => {
    expect(parseArpTable(ARP_WINDOWS_EN)).toEqual([
      { ip: '10.0.0.1', mac: '00:0C:42:DE:AD:BE' },
      { ip: '10.0.0.9', mac: 'B8:27:EB:01:02:03' }
    ]);
  });

  test('Linux, e ignora entradas incompletas', () => {
    expect(parseArpTable(ARP_LINUX)).toEqual([
      { ip: '192.168.88.1', mac: 'CC:2D:E0:11:22:33' },
      { ip: '192.168.88.20', mac: 'F0:9F:C2:AA:BB:CC' }
    ]);
  });

  test('a linha "Interface:" tem IP mas não MAC e não vira equipamento', () => {
    const ips = parseArpTable(ARP_WINDOWS_PT).map((row) => row.ip);
    expect(ips).not.toContain('192.168.1.10');
  });

  test('stdout vazio ou lixo não estoura', () => {
    expect(parseArpTable('')).toEqual([]);
    expect(parseArpTable('nada de útil aqui')).toEqual([]);
  });
});

describe('normalizeMac', () => {
  test('normaliza os dois separadores para maiúsculas com dois-pontos', () => {
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('AA:BB:CC:DD:EE:FF');
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('AA:BB:CC:DD:EE:FF');
  });

  test('descarta broadcast e multicast (bit menos significativo do 1.º octeto)', () => {
    expect(normalizeMac('ff-ff-ff-ff-ff-ff')).toBeNull();
    expect(normalizeMac('01-00-5e-00-00-16')).toBeNull();
  });

  test('nulo, vazio e lixo dão null', () => {
    for (const bad of [null, undefined, '', 'aa-bb-cc', 'não é um mac']) {
      expect(normalizeMac(bad)).toBeNull();
    }
  });
});

describe('vendorForMac', () => {
  // Prefixos lidos da tabela ARP da rede real onde isto corre.
  test('reconhece o parque real', () => {
    expect(vendorForMac('3C:64:CF:7B:89:10')).toBe('TP-Link');
    expect(vendorForMac('30:16:9D:AA:53:8B')).toBe('MERCUSYS');
    expect(vendorForMac('F0:9F:C2:00:00:01')).toBe('Ubiquiti');
  });

  // O IEEE guarda o nome que o titular registou, não a marca comercial: o bloco
  // da MikroTik está em nome de "Routerboard.com". Traduzir marcas seria uma
  // tabela paralela a manter à mão — o nome registado é a verdade verificável.
  test('devolve o nome registado, mesmo quando difere da marca', () => {
    expect(vendorForMac('00:0c:42:11:22:33')).toBe('Routerboard.com');
  });

  test('o nome sai limpo, sem os sufixos societários nem pontuação órfã', () => {
    for (const mac of ['3C:64:CF:00:00:01', '30:16:9D:00:00:01', '00:0C:42:00:00:01']) {
      const vendor = vendorForMac(mac)!;
      expect(vendor).not.toMatch(/\b(Co|Corp|Inc|Ltd|LLC|Technologies)\b/i);
      expect(vendor).not.toMatch(/[\s.,;:-]$/);
    }
  });

  test('OUI por atribuir devolve null em vez de inventar', () => {
    expect(vendorForMac('FE:FE:FE:00:00:01')).toBeNull();
  });

  test('MAC aleatório (bit administrado localmente) não tem fabricante', () => {
    expect(vendorForMac('A6:F3:F1:5A:D7:BA')).toBeNull();
  });

  test('null entra, null sai', () => {
    expect(vendorForMac(null)).toBeNull();
  });
});

// -------------------------------------------------------------- varrimento

describe('sweep', () => {
  const fakePing = (alive: string[]): Pinger => async (ip) =>
    alive.includes(ip) ? { ok: true, rttMs: 4 } : { ok: false, rttMs: null };

  test('devolve uma linha por endereço, na ordem de entrada', async () => {
    const ips = ['192.168.1.1', '192.168.1.2', '192.168.1.3'];
    const results = await sweep(ips, { ping: fakePing(['192.168.1.2']) });
    expect(results.map((r) => r.ip)).toEqual(ips);
    expect(results.map((r) => r.ok)).toEqual([false, true, false]);
    expect(results[1].rttMs).toBe(4);
  });

  test('lista vazia não estoura', async () => {
    expect(await sweep([], { ping: fakePing([]) })).toEqual([]);
  });

  test('respeita o limite de concorrência', async () => {
    let live = 0;
    let peak = 0;
    const ping: Pinger = async (_ip) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      return { ok: true, rttMs: 1 };
    };
    await sweep(Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`), { ping, concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------- histórico

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const host = (over: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
  ip: '192.168.1.42',
  mac: '50:C7:BF:AA:BB:CC',
  hostname: null,
  source: 'ping',
  ...over
});

// ----------------------------------------------------- endereços ocupados

function seedCatalog(db: Database.Database, model: string): number {
  return db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'cpe', 'TP-Link', ?, 1, 3000, 5, 1)
  `).run(model).lastInsertRowid as number;
}

function seedAssignment(
  db: Database.Database,
  ip: string,
  options: { serviceStatus?: string; endDate?: string | null } = {}
): void {
  const catalogId = seedCatalog(db, `CPE ${ip}`);
  const clientId = db.prepare(`
    INSERT INTO clients (client_code, full_name, status) VALUES (?, ?, 'active')
  `).run(`CLI-${ip}`, `Cliente ${ip}`).lastInsertRowid as number;
  const serviceId = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status) VALUES (?, 2500, 10, ?)
  `).run(clientId, options.serviceStatus ?? 'active').lastInsertRowid as number;
  db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, ip_address, start_date, end_date)
    VALUES (?, ?, ?, '2026-01-01', ?)
  `).run(serviceId, catalogId, ip, options.endDate ?? null);
}

function seedBackbone(db: Database.Database, ip: string, status: string): void {
  const catalogId = seedCatalog(db, `Antena ${ip}`);
  db.prepare(`
    INSERT INTO backbone_devices (catalog_id, name, ip_address, status) VALUES (?, ?, ?, ?)
  `).run(catalogId, `Antena ${ip}`, ip, status);
}

describe('loadRegisteredDevices', () => {
  test('o equipamento instalado ocupa o endereço mesmo com o serviço parado', () => {
    const db = freshDb();
    seedAssignment(db, '192.168.1.10', { serviceStatus: 'active' });
    seedAssignment(db, '192.168.1.11', { serviceStatus: 'suspended' });
    seedAssignment(db, '192.168.1.12', { serviceStatus: 'cancelled' });

    const rows = loadRegisteredDevices(db);
    expect(rows.map((r) => r.ip).sort()).toEqual(['192.168.1.10', '192.168.1.11', '192.168.1.12']);
    // O `active` separa quem devia estar de pé de quem está cortado.
    expect(rows.find((r) => r.ip === '192.168.1.10')?.active).toBe(true);
    expect(rows.find((r) => r.ip === '192.168.1.11')?.active).toBe(false);
    expect(rows.find((r) => r.ip === '192.168.1.12')?.active).toBe(false);
    db.close();
  });

  test('retirar o equipamento é o que liberta o endereço', () => {
    const db = freshDb();
    seedAssignment(db, '192.168.1.13', { endDate: '2026-08-01' });
    expect(loadRegisteredDevices(db)).toEqual([]);
    db.close();
  });

  test('backbone ocupa até ser abatido; em manutenção ainda devia responder', () => {
    const db = freshDb();
    seedBackbone(db, '192.168.1.20', 'active');
    seedBackbone(db, '192.168.1.21', 'maintenance');
    seedBackbone(db, '192.168.1.22', 'retired');

    const rows = loadRegisteredDevices(db);
    expect(rows.map((r) => r.ip).sort()).toEqual(['192.168.1.20', '192.168.1.21']);
    expect(rows.every((r) => r.active)).toBe(true);
    db.close();
  });
});

describe('persistSeen', () => {
  test('primeira vez insere com times_seen = 1 e preenche o fabricante', () => {
    const db = freshDb();
    persistSeen(db, [host()]);
    const [row] = loadSeenHosts(db);
    expect(row.ipAddress).toBe('192.168.1.42');
    expect(row.vendor).toBe('TP-LINK');
    expect(row.timesSeen).toBe(1);
    db.close();
  });

  test('segunda vez incrementa e preserva o first_seen_at', () => {
    const db = freshDb();
    persistSeen(db, [host()]);
    const first = loadSeenHosts(db)[0].firstSeenAt;
    persistSeen(db, [host()]);
    const [row] = loadSeenHosts(db);
    expect(row.timesSeen).toBe(2);
    expect(row.firstSeenAt).toBe(first);
    db.close();
  });

  test('um varrimento sem MAC não apaga o MAC já conhecido', () => {
    const db = freshDb();
    persistSeen(db, [host()]);
    persistSeen(db, [host({ mac: null })]);
    expect(loadSeenHosts(db)[0].macAddress).toBe('50:C7:BF:AA:BB:CC');
    db.close();
  });

  test('purga o que não é visto há mais de 90 dias', () => {
    const db = freshDb();
    persistSeen(db, [host({ ip: '192.168.1.7' })]);
    db.prepare(`UPDATE network_discovery_hosts SET last_seen_at = date('now','-200 days')`).run();
    persistSeen(db, [host({ ip: '192.168.1.8' })]);
    expect(loadSeenHosts(db).map((r) => r.ipAddress)).toEqual(['192.168.1.8']);
    db.close();
  });

  test('lista vazia não escreve nem purga', () => {
    const db = freshDb();
    persistSeen(db, [host()]);
    persistSeen(db, []);
    expect(loadSeenHosts(db)).toHaveLength(1);
    db.close();
  });
});

// ------------------------------------------------------------- modelo

describe('loadRegisteredDevices — modelo do catálogo', () => {
  test('o registo traz marca e modelo já compostos', () => {
    const db = freshDb();
    seedAssignment(db, '192.168.1.30');
    seedBackbone(db, '192.168.1.31', 'active');

    const rows = loadRegisteredDevices(db);
    expect(rows.find((r) => r.ip === '192.168.1.30')?.model).toBe('TP-Link CPE 192.168.1.30');
    expect(rows.find((r) => r.ip === '192.168.1.31')?.model).toBe('TP-Link Antena 192.168.1.31');
    db.close();
  });
});

describe('persistModel — precedência entre fontes', () => {
  /** A linha do endereço tem de existir: é o varrimento que a cria. */
  function fresh(ip: string): Database.Database {
    const db = freshDb();
    persistSeen(db, [host({ ip })]);
    return db;
  }

  function modelOf(db: Database.Database, ip: string) {
    return db.prepare(
      `SELECT model, model_source AS source, model_detail AS detail FROM network_discovery_hosts WHERE ip_address = ?`
    ).get(ip) as { model: string | null; source: string | null; detail: string | null } | undefined;
  }

  test('uma fonte melhor substitui a pior', () => {
    const db = fresh('192.168.1.50');
    expect(persistModel(db, { ip: '192.168.1.50', model: 'CPE-web', source: 'http' })).toBe(true);
    expect(persistModel(db, { ip: '192.168.1.50', model: 'CPE710', source: 'snmp' })).toBe(true);
    expect(modelOf(db, '192.168.1.50')?.model).toBe('CPE710');
    db.close();
  });

  test('uma fonte pior NÃO apaga a melhor', () => {
    const db = fresh('192.168.1.51');
    persistModel(db, { ip: '192.168.1.51', model: 'CPE710', source: 'snmp' });
    expect(persistModel(db, { ip: '192.168.1.51', model: 'Login', source: 'http' })).toBe(false);
    expect(modelOf(db, '192.168.1.51')?.model).toBe('CPE710');
    db.close();
  });

  test('a mesma fonte volta a escrever — o equipamento pode ter sido trocado', () => {
    const db = fresh('192.168.1.52');
    persistModel(db, { ip: '192.168.1.52', model: 'CPE210', source: 'snmp' });
    expect(persistModel(db, { ip: '192.168.1.52', model: 'CPE710', source: 'snmp' })).toBe(true);
    expect(modelOf(db, '192.168.1.52')?.model).toBe('CPE710');
    db.close();
  });

  test('sem modelo legível guarda a prova e não toca no modelo que lá está', () => {
    const db = fresh('192.168.1.53');
    persistModel(db, { ip: '192.168.1.53', model: 'CPE710', source: 'snmp' });
    expect(persistModel(db, { ip: '192.168.1.53', model: null, source: 'http', detail: 'http 200 | title=Login' })).toBe(false);
    const row = modelOf(db, '192.168.1.53');
    expect(row?.model).toBe('CPE710');
    expect(row?.detail).toBe('http 200 | title=Login');
    db.close();
  });

  test('vizinho do router num endereço nunca varrido cria a linha', () => {
    const db = freshDb();
    expect(persistModel(db, { ip: '10.0.0.7', model: 'RB951Ui-2HnD', source: 'router' })).toBe(true);
    expect(modelOf(db, '10.0.0.7')?.model).toBe('RB951Ui-2HnD');
    db.close();
  });

  test('uma sondagem sobre um endereço sem linha não inventa avistamento', () => {
    const db = freshDb();
    expect(persistModel(db, { ip: '10.0.0.8', model: 'CPE710', source: 'snmp' })).toBe(false);
    expect(modelOf(db, '10.0.0.8')).toBeUndefined();
    db.close();
  });
});

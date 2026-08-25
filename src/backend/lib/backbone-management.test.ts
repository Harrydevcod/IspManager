import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
  BackboneConflictError,
  BackboneValidationError,
  clearAssignmentBackbone,
  createBackbone,
  getBackbone,
  listAssignments,
  listBackbones,
  setAssignmentBackbone,
  updateBackbone
} from './backbone-management';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database) {
  const actor = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name)
    VALUES ('operator', 'hash', 'operator', 'Operador')
  `).run();
  const catalog = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'antena', 'Ubiquiti', 'Rocket Prism', 1, 10000, 10, 1)
  `).run();
  const otherCatalog = db.prepare(`
    INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
    VALUES ('equipamento', 'cpe', 'Ubiquiti', 'LiteBeam', 1, 3000, 10, 1)
  `).run();
  const client = db.prepare(`
    INSERT INTO clients (client_code, full_name, island, zone, status)
    VALUES ('CLT-001', 'Ana Silva', 'Santiago', 'Praia', 'active')
  `).run();
  const service = db.prepare(`
    INSERT INTO services (client_id, monthly_value_cve, due_day, status)
    VALUES (?, 3500, 10, 'active')
  `).run(client.lastInsertRowid);
  const activeAssignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, serial_number, asset_tag, ip_address, mac_address)
    VALUES (?, ?, ' CPE-01 ', ' ASSET-01 ', '10.0.0.10', 'aa:bb:cc:dd:ee:01')
  `).run(service.lastInsertRowid, otherCatalog.lastInsertRowid);
  const inactiveAssignment = db.prepare(`
    INSERT INTO service_device_assignments (service_id, catalog_id, end_date)
    VALUES (?, ?, date('now'))
  `).run(service.lastInsertRowid, otherCatalog.lastInsertRowid);
  return {
    catalogId: Number(catalog.lastInsertRowid),
    otherCatalogId: Number(otherCatalog.lastInsertRowid),
    actorId: Number(actor.lastInsertRowid),
    activeAssignmentId: Number(activeAssignment.lastInsertRowid),
    inactiveAssignmentId: Number(inactiveAssignment.lastInsertRowid)
  };
}

function input(catalogId: number, overrides: Record<string, unknown> = {}) {
  return {
    catalogId,
    name: '  Core Norte  ',
    status: 'active' as const,
    serialNumber: ' SN-001 ',
    assetTag: ' AT-001 ',
    ipAddress: ' 10.0.0.1 ',
    macAddress: 'aa:bb:cc:dd:ee:ff',
    island: ' Santiago ',
    zone: ' Praia ',
    notes: '  Torre principal ',
    upstreamDeviceIds: [] as number[],
    ...overrides
  };
}

let db: Database.Database | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe('backbone management repository', () => {
  test('normalizes identity fields and returns a complete backbone detail', () => {
    db = freshDb();
    const fixture = seed(db);

    const created = createBackbone(db, input(fixture.catalogId), null);

    expect(created).toMatchObject({
      name: 'Core Norte', serialNumber: 'SN-001', assetTag: 'AT-001',
      ipAddress: '10.0.0.1', macAddress: 'AA:BB:CC:DD:EE:FF',
      island: 'Santiago', zone: 'Praia', notes: 'Torre principal',
      provisional: false, linkedAssignmentCount: 0, assignments: []
    });
    expect(getBackbone(db, created.id)).toEqual(created);
  });

  test('paginates and filters normalized backbone search results', () => {
    db = freshDb();
    const fixture = seed(db);
    createBackbone(db, input(fixture.catalogId, { name: 'Core Sul', serialNumber: null, assetTag: null }), null);
    createBackbone(db, input(fixture.catalogId, { name: 'Core Norte', serialNumber: 'SERIAL-NORTE', status: 'maintenance' }), null);

    const page = listBackbones(db, { query: '  serial-norte ', status: 'maintenance', page: 9, pageSize: 999 });

    expect(page).toMatchObject({ page: 1, pageSize: 100, total: 1, totalPages: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ name: 'Core Norte', status: 'maintenance' });
  });

  test('lists only active unlinked assignments and searches their factual context', () => {
    db = freshDb();
    const fixture = seed(db);
    const backbone = createBackbone(db, input(fixture.catalogId), null);

    const all = listAssignments(db, { mapping: 'unlinked', query: ' ana silva ', page: 1, pageSize: 25 });
    expect(all.items).toEqual([expect.objectContaining({
      id: fixture.activeAssignmentId, clientCode: 'CLT-001', clientName: 'Ana Silva', backboneDeviceId: null
    })]);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: backbone.id, reason: null }, null);
    expect(listAssignments(db, { mapping: 'unlinked', page: 1, pageSize: 25 }).items).toEqual([]);
    expect(listAssignments(db, { mapping: 'linked', backboneDeviceId: backbone.id, page: 1, pageSize: 25 }).items)
      .toEqual([expect.objectContaining({ id: fixture.activeAssignmentId, backboneDeviceId: backbone.id })]);
    expect(() => setAssignmentBackbone(db!, fixture.inactiveAssignmentId, { backboneDeviceId: backbone.id, reason: null }, null))
      .toThrow(BackboneValidationError);
  });

  /**
   * "Por ligar" é uma dívida que alguém pode saldar. O router do cliente não
   * pertence a essa conta nem à lista de candidatos: pende da antena dele.
   */
  test('leaves equipment that can never reach the backbone out of the pending list', () => {
    db = freshDb();
    const fixture = seed(db);
    const routerCatalogId = Number(db.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('equipamento', 'router', 'TP-Link', 'Archer C20', 0, 2000, 10, 1)
    `).run().lastInsertRowid);
    const routerAssignmentId = Number(db.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id)
      SELECT service_id, ? FROM service_device_assignments WHERE id = ?
    `).run(routerCatalogId, fixture.activeAssignmentId).lastInsertRowid);

    const pending = listAssignments(db, { mapping: 'unlinked', page: 1, pageSize: 25 });
    expect(pending.items.map((item) => item.id)).toEqual([fixture.activeAssignmentId]);
    expect(pending.total).toBe(1);

    // Sem filtro continua a ver-se tudo: o inventário não esconde equipamento.
    expect(listAssignments(db, { mapping: 'all', page: 1, pageSize: 25 }).items.map((item) => item.id))
      .toContain(routerAssignmentId);

    // Uma ligação antiga a um router tem de continuar à vista para se desfazer.
    const backbone = createBackbone(db, input(fixture.catalogId), null);
    db.prepare(`
      INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id) VALUES (?, ?)
    `).run(backbone.id, routerAssignmentId);
    expect(listAssignments(db, {
      mapping: 'linked', backboneDeviceId: backbone.id, page: 1, pageSize: 25
    }).items.map((item) => item.id)).toEqual([routerAssignmentId]);
  });

  test('updates optimistically and rejects stale or retired-with-links changes', () => {
    db = freshDb();
    const fixture = seed(db);
    expect(() => createBackbone(db!, input(fixture.catalogId, { status: 'invalid-status' }), null))
      .toThrow(BackboneValidationError);
    const created = createBackbone(db, input(fixture.catalogId), null);
    const updated = updateBackbone(db, created.id, input(fixture.catalogId, {
      name: 'Core Atualizado', expectedUpdatedAt: created.updatedAt
    }), null);

    expect(updated.name).toBe('Core Atualizado');
    expect(() => updateBackbone(db!, created.id, input(fixture.catalogId, {
      name: 'Versão antiga', expectedUpdatedAt: created.updatedAt
    }), null)).toThrow(BackboneConflictError);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: created.id, reason: null }, null);
    expect(() => updateBackbone(db!, created.id, input(fixture.catalogId, { status: 'retired' }), null))
      .toThrow(BackboneValidationError);
  });

  test('transfers and clears an assignment atomically while retaining link history', () => {
    db = freshDb();
    const fixture = seed(db);
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Core A' }), null);
    const second = createBackbone(db, input(fixture.catalogId, { name: 'Core B', serialNumber: 'SN-002', assetTag: 'AT-002' }), null);

    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: first.id, reason: 'Instalação' }, fixture.actorId);
    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: second.id, reason: 'Transferência' }, fixture.actorId);

    expect(db.prepare(`
      SELECT backbone_device_id AS backboneDeviceId, ended_at AS endedAt, ended_by AS endedBy, change_reason AS reason
      FROM backbone_assignment_links WHERE assignment_id = ? ORDER BY id
    `).all(fixture.activeAssignmentId)).toEqual([
      expect.objectContaining({ backboneDeviceId: first.id, endedAt: expect.any(String), endedBy: fixture.actorId, reason: 'Transferência' }),
      expect.objectContaining({ backboneDeviceId: second.id, endedAt: null, endedBy: null, reason: 'Transferência' })
    ]);

    clearAssignmentBackbone(db, fixture.activeAssignmentId, ' Retirado ', fixture.actorId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM backbone_assignment_links WHERE assignment_id = ? AND ended_at IS NULL').get(fixture.activeAssignmentId))
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT ended_by AS endedBy, change_reason AS reason FROM backbone_assignment_links WHERE assignment_id = ? ORDER BY id DESC LIMIT 1').get(fixture.activeAssignmentId))
      .toEqual({ endedBy: fixture.actorId, reason: 'Retirado' });
  });

  /**
   * O router do cliente entra no mapa pela antena dele. Aceitar aqui um link
   * directo desenhava-o ao lado da antena, com o cliente repetido no mapa.
   */
  test('refuses to hang anything other than an antenna or CPE on the backbone', () => {
    db = freshDb();
    const database = db;
    const fixture = seed(database);
    const backbone = createBackbone(database, input(fixture.catalogId), null);
    const routerCatalogId = Number(database.prepare(`
      INSERT INTO equipment_catalog (category, type, brand, model, is_serialized, purchase_price_cve, stock_total, active)
      VALUES ('equipamento', 'router', 'TP-Link', 'Archer C20', 0, 2000, 10, 1)
    `).run().lastInsertRowid);
    const routerAssignmentId = Number(database.prepare(`
      INSERT INTO service_device_assignments (service_id, catalog_id)
      SELECT service_id, ? FROM service_device_assignments WHERE id = ?
    `).run(routerCatalogId, fixture.activeAssignmentId).lastInsertRowid);

    expect(() => setAssignmentBackbone(
      database,
      routerAssignmentId,
      { backboneDeviceId: backbone.id, reason: 'Instalação' },
      fixture.actorId
    )).toThrow(/Só antenas e CPE ligam ao backbone/);
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM backbone_assignment_links WHERE assignment_id = ?'
    ).get(routerAssignmentId)).toEqual({ count: 0 });

    // A antena do mesmo serviço continua a poder ligar-se.
    expect(() => setAssignmentBackbone(
      database,
      fixture.activeAssignmentId,
      { backboneDeviceId: backbone.id, reason: 'Instalação' },
      fixture.actorId
    )).not.toThrow();
  });

  test('keeps the current active link when a transfer insert is rejected', () => {
    db = freshDb();
    const fixture = seed(db);
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Core A' }), null);
    const blocked = createBackbone(db, input(fixture.catalogId, {
      name: 'Core Bloqueado', serialNumber: 'SN-002', assetTag: 'AT-002'
    }), null);
    setAssignmentBackbone(db, fixture.activeAssignmentId, { backboneDeviceId: first.id, reason: null }, fixture.actorId);
    db.exec(`
      CREATE TRIGGER reject_blocked_backbone_link
      BEFORE INSERT ON backbone_assignment_links
      WHEN NEW.backbone_device_id = ${blocked.id}
      BEGIN
        SELECT RAISE(ABORT, 'blocked transfer insert');
      END;
    `);

    expect(() => setAssignmentBackbone(db!, fixture.activeAssignmentId, {
      backboneDeviceId: blocked.id, reason: 'Transferência falhada'
    }, fixture.actorId)).toThrow('blocked transfer insert');
    expect(listAssignments(db, {
      mapping: 'linked', backboneDeviceId: first.id, page: 1, pageSize: 25
    }).items).toEqual([expect.objectContaining({ id: fixture.activeAssignmentId, backboneDeviceId: first.id })]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM backbone_assignment_links
      WHERE assignment_id = ? AND ended_at IS NULL
    `).get(fixture.activeAssignmentId)).toEqual({ count: 1 });
  });

  test('counts and lists the units a backbone feeds, ignoring retired ones', () => {
    db = freshDb();
    const fixture = seed(db);
    const head = createBackbone(db, input(fixture.catalogId, { name: 'Starlink' }), null);
    const fed = createBackbone(db, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-002', assetTag: 'AT-002', upstreamDeviceIds: [head.id]
    }), null);
    const gone = createBackbone(db, input(fixture.catalogId, {
      name: 'AP Retirado', serialNumber: 'SN-003', assetTag: 'AT-003', upstreamDeviceIds: [head.id]
    }), null);
    updateBackbone(db, gone.id, input(fixture.catalogId, {
      name: 'AP Retirado', serialNumber: 'SN-003', assetTag: 'AT-003',
      status: 'retired', upstreamDeviceIds: [head.id]
    }), null);

    // Uma unidade de trânsito não tem CPE; sem esta contagem lia-se vazia.
    const detail = getBackbone(db, head.id);
    expect(detail?.linkedAssignmentCount).toBe(0);
    expect(detail?.downstreamCount).toBe(1);
    expect(detail?.downstream.map((unit) => unit.id)).toEqual([fed.id]);
    expect(getBackbone(db, fed.id)?.downstreamCount).toBe(0);

    // O filtro cru devolve tudo o que aponta para a cabeça; é o detalhe que
    // decide não mostrar as retiradas.
    expect(listBackbones(db, { upstreamDeviceId: head.id, page: 1, pageSize: 25 })
      .items.map((unit) => unit.name)).toEqual(['AP Espia', 'AP Retirado']);
  });

  test('records the upstream chain and refuses the links that would break it', () => {
    db = freshDb();
    const fixture = seed(db);
    const head = createBackbone(db, input(fixture.catalogId, { name: 'Starlink' }), null);
    const middle = createBackbone(db, input(fixture.catalogId, {
      name: 'Router Starlink', serialNumber: 'SN-002', assetTag: 'AT-002',
      upstreamDeviceIds: [head.id]
    }), null);
    const leaf = createBackbone(db, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [middle.id]
    }), null);

    expect(middle.upstreams).toEqual([{ id: head.id, name: 'Starlink' }]);
    expect(head.upstreams).toEqual([]);

    // Auto-referência, ciclo indirecto e upstream inexistente.
    expect(() => updateBackbone(db!, head.id, input(fixture.catalogId, {
      name: 'Starlink', upstreamDeviceIds: [head.id]
    }), null)).toThrow(BackboneValidationError);
    expect(() => updateBackbone(db!, head.id, input(fixture.catalogId, {
      name: 'Starlink', upstreamDeviceIds: [leaf.id]
    }), null)).toThrow(BackboneValidationError);
    expect(() => createBackbone(db!, input(fixture.catalogId, {
      name: 'Orfão', serialNumber: 'SN-004', assetTag: 'AT-004', upstreamDeviceIds: [9999]
    }), null)).toThrow(BackboneValidationError);

    // Retirar uma unidade que ainda alimenta outra fica bloqueado.
    expect(() => updateBackbone(db!, middle.id, input(fixture.catalogId, {
      name: 'Router Starlink', serialNumber: 'SN-002', assetTag: 'AT-002',
      status: 'retired', upstreamDeviceIds: [head.id]
    }), null)).toThrow(BackboneValidationError);

    // Reencaminhado o jusante, a unidade já pode ser retirada — e deixa de ser
    // um upstream aceitável.
    updateBackbone(db, leaf.id, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [head.id]
    }), null);
    const retired = updateBackbone(db, middle.id, input(fixture.catalogId, {
      name: 'Router Starlink', serialNumber: 'SN-002', assetTag: 'AT-002',
      status: 'retired', upstreamDeviceIds: [head.id]
    }), null);
    expect(retired.status).toBe('retired');
    expect(() => updateBackbone(db!, leaf.id, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [middle.id]
    }), null)).toThrow(BackboneValidationError);
  });

  test('aggregates several internet uplinks on one multi-WAN device', () => {
    db = freshDb();
    const fixture = seed(db);
    // Duas Starlink na base da Internet, agregadas num router de portas WAN.
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Starlink 1' }), null);
    const second = createBackbone(db, input(fixture.catalogId, {
      name: 'Starlink 2', serialNumber: 'SN-002', assetTag: 'AT-002'
    }), null);
    const router = createBackbone(db, input(fixture.catalogId, {
      name: 'Router multi-WAN', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [first.id, second.id]
    }), null);

    expect(first.upstreams).toEqual([]);
    expect(second.upstreams).toEqual([]);
    expect(router.upstreams).toEqual([
      { id: first.id, name: 'Starlink 1' },
      { id: second.id, name: 'Starlink 2' }
    ]);
    expect(getBackbone(db, first.id)?.downstreamCount).toBe(1);
    expect(getBackbone(db, second.id)?.downstreamCount).toBe(1);

    // Uma terceira antena entra sem apagar as anteriores.
    const third = createBackbone(db, input(fixture.catalogId, {
      name: 'Starlink 3', serialNumber: 'SN-004', assetTag: 'AT-004'
    }), null);
    const grown = updateBackbone(db, router.id, input(fixture.catalogId, {
      name: 'Router multi-WAN', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [first.id, second.id, third.id]
    }), null);
    expect(grown.upstreams.map((unit) => unit.id)).toEqual([first.id, second.id, third.id]);

    // Repetir a mesma alimentação não duplica a ligação.
    const deduped = updateBackbone(db, router.id, input(fixture.catalogId, {
      name: 'Router multi-WAN', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [first.id, first.id]
    }), null);
    expect(deduped.upstreams.map((unit) => unit.id)).toEqual([first.id]);
  });

  test('refuses a cycle closed through a second path of the graph', () => {
    db = freshDb();
    const fixture = seed(db);
    // first → router → leaf. Alimentar a `first` a partir da `leaf` fecharia o
    // circuito por um caminho que a subida linear de um só pai não via.
    const first = createBackbone(db, input(fixture.catalogId, { name: 'Starlink 1' }), null);
    const second = createBackbone(db, input(fixture.catalogId, {
      name: 'Starlink 2', serialNumber: 'SN-002', assetTag: 'AT-002'
    }), null);
    const router = createBackbone(db, input(fixture.catalogId, {
      name: 'Router multi-WAN', serialNumber: 'SN-003', assetTag: 'AT-003',
      upstreamDeviceIds: [first.id, second.id]
    }), null);
    const leaf = createBackbone(db, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-004', assetTag: 'AT-004',
      upstreamDeviceIds: [router.id]
    }), null);

    expect(() => updateBackbone(db!, second.id, input(fixture.catalogId, {
      name: 'Starlink 2', serialNumber: 'SN-002', assetTag: 'AT-002',
      upstreamDeviceIds: [leaf.id]
    }), null)).toThrow(BackboneValidationError);

    // A cadeia intacta continua a aceitar uma alimentação legítima.
    const relinked = updateBackbone(db, leaf.id, input(fixture.catalogId, {
      name: 'AP Espia', serialNumber: 'SN-004', assetTag: 'AT-004',
      upstreamDeviceIds: [router.id, first.id]
    }), null);
    // A lista vem ordenada por nome: "Router multi-WAN" antes de "Starlink 1".
    expect(relinked.upstreams.map((unit) => unit.id)).toEqual([router.id, first.id]);
  });
});

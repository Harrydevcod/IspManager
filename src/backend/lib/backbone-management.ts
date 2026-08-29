import type Database from 'better-sqlite3';
import { normalizeMacAddress } from '../../shared/mac';
import { BACKBONE_UPLINK_TYPES, BACKBONE_UPLINK_TYPES_SQL } from '../../shared/topology';
import { PLACEMENT_CTE } from './topology-read-model';
import type {
  AssignmentBackboneInput,
  AssignmentListQuery,
  BackboneAssignmentSummary,
  BackboneDeviceDetail,
  BackboneDeviceSummary,
  BackboneListQuery,
  BackbonePage,
  BackboneStatus,
  BackboneUpstreamRef,
  BackboneWriteInput
} from '../../shared/backbone';

export class BackboneNotFoundError extends Error {}
export class BackboneConflictError extends Error {}
export class BackboneValidationError extends Error {}

type BackboneRow = Omit<BackboneDeviceSummary, 'provisional' | 'upstreams'> & { provisional: number };
type AssignmentRow = BackboneAssignmentSummary;
const BACKBONE_STATUSES: ReadonlySet<BackboneStatus> = new Set(['active', 'maintenance', 'retired']);

const BACKBONE_COLUMNS = `
  bd.id, bd.catalog_id AS catalogId, ec.brand AS catalogBrand, ec.model AS catalogModel,
  ec.type AS catalogType, bd.name, bd.status, bd.serial_number AS serialNumber,
  bd.asset_tag AS assetTag, bd.ip_address AS ipAddress, bd.mac_address AS macAddress,
  bd.island, bd.zone, bd.provisional,
  bd.created_at AS createdAt, bd.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM backbone_links down
   JOIN backbone_devices dev ON dev.id = down.device_id
   WHERE down.upstream_device_id = bd.id AND dev.status <> 'retired')
    AS downstreamCount,
  COUNT(active_link.id) AS linkedAssignmentCount`;

const ASSIGNMENT_COLUMNS = `
  a.id, a.catalog_id AS catalogId, ec.brand AS catalogBrand, ec.model AS catalogModel,
  ec.type AS catalogType, a.serial_number AS serialNumber, a.asset_tag AS assetTag,
  a.ip_address AS ipAddress, a.mac_address AS macAddress, a.start_date AS startDate,
  c.id AS clientId, c.client_code AS clientCode, c.full_name AS clientName,
  s.id AS serviceId, s.status AS serviceStatus, link.backbone_device_id AS backboneDeviceId,
  bd.name AS backboneName, link.started_at AS linkedAt`;

function normalizeOptional(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

/** Mesma forma canónica do equipamento instalado — ver `shared/mac.ts`. */
const normalizeMac = normalizeMacAddress;

function normalizeQuery(value: string | undefined): string | null {
  const normalized = value
    ?.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt');
  return normalized || null;
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function pageBounds(page: number, pageSize: number, total: number): { page: number; pageSize: number; totalPages: number } {
  const boundedPageSize = Math.min(100, Math.max(1, Math.trunc(pageSize) || 25));
  const totalPages = Math.max(1, Math.ceil(total / boundedPageSize));
  return {
    page: Math.min(totalPages, Math.max(1, Math.trunc(page) || 1)),
    pageSize: boundedPageSize,
    totalPages
  };
}

function backboneFromRow(row: BackboneRow, upstreams: BackboneUpstreamRef[]): BackboneDeviceSummary {
  return { ...row, provisional: row.provisional === 1, upstreams };
}

/**
 * As alimentações de cada unidade, numa só consulta para a página inteira: um
 * equipamento multi-WAN tem várias, e um JOIN na leitura principal duplicaria
 * as linhas do agregado de CPE ligadas.
 */
function upstreamsByDevice(
  db: Database.Database,
  deviceIds: number[]
): Map<number, BackboneUpstreamRef[]> {
  const grouped = new Map<number, BackboneUpstreamRef[]>();
  if (deviceIds.length === 0) return grouped;
  const rows = db.prepare(`
    SELECT link.device_id AS deviceId, up.id, up.name
    FROM backbone_links link
    JOIN backbone_devices up ON up.id = link.upstream_device_id
    WHERE link.device_id IN (${deviceIds.map(() => '?').join(', ')})
    ORDER BY up.name COLLATE NOCASE, up.id
  `).all(...deviceIds) as Array<BackboneUpstreamRef & { deviceId: number }>;
  for (const { deviceId, id, name } of rows) {
    const current = grouped.get(deviceId);
    if (current) current.push({ id, name });
    else grouped.set(deviceId, [{ id, name }]);
  }
  return grouped;
}

function replaceUpstreams(
  db: Database.Database,
  deviceId: number,
  upstreamDeviceIds: number[],
  actorId: number | null
): void {
  db.prepare('DELETE FROM backbone_links WHERE device_id = ?').run(deviceId);
  const insert = db.prepare(`
    INSERT INTO backbone_links (device_id, upstream_device_id, created_by) VALUES (?, ?, ?)
  `);
  for (const upstreamId of upstreamDeviceIds) insert.run(deviceId, upstreamId, actorId);
}

function assignmentFromRow(row: AssignmentRow): BackboneAssignmentSummary {
  return row;
}

function backboneSearchClause(query: string | null, params: unknown[]): string {
  if (!query) return '';
  const candidate = like(query);
  const fields = [
    'bd.name', 'ec.model', 'bd.serial_number', 'bd.asset_tag', 'bd.ip_address',
    'bd.mac_address', 'bd.island', 'bd.zone'
  ];
  params.push(...fields.map(() => candidate));
  return ` AND (${fields.map((field) => `lower(trim(coalesce(${field}, ''))) LIKE ? ESCAPE '\\'`).join(' OR ')})`;
}

function assignmentSearchClause(query: string | null, params: unknown[]): string {
  if (!query) return '';
  const candidate = like(query);
  const fields = [
    'c.client_code', 'c.full_name', 'CAST(s.id AS TEXT)', 's.ip_address',
    'a.ip_address', 'a.mac_address', 'a.serial_number', 'a.asset_tag', 'ec.model'
  ];
  params.push(...fields.map(() => candidate));
  return ` AND (${fields.map((field) => `lower(trim(coalesce(${field}, ''))) LIKE ? ESCAPE '\\'`).join(' OR ')})`;
}

function activeAssignmentRow(
  db: Database.Database,
  assignmentId: number
): { id: number; catalogType: string } {
  const row = db.prepare(`
    SELECT a.id, ec.type AS catalogType
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    WHERE a.id = ? AND a.end_date IS NULL
  `).get(assignmentId) as { id: number; catalogType: string } | undefined;
  if (!row) throw new BackboneValidationError('Atribuição ativa não encontrada');
  return row;
}

function ensureCatalog(db: Database.Database, catalogId: number): void {
  const row = db.prepare('SELECT id FROM equipment_catalog WHERE id = ?').get(catalogId);
  if (!row) throw new BackboneValidationError('Catálogo não encontrado');
}

const LANDED_COST_SQL = '(purchase_price_cve + shipping_cost_cve + customs_duty_cve + other_costs_cve)';

/**
 * O modelo cujo stock esta unidade ocupa — nenhum, quando está retirada.
 *
 * Uma unidade de backbone está no terreno, não no armazém: enquanto o estado não
 * for retirado consome 1 do stock do seu modelo. O backbone era o único caminho
 * que tirava equipamento do armazém sem lhe dar baixa, e por isso o inventário
 * continuava a oferecer unidades que já estavam num poste.
 */
function stockHolder(status: BackboneStatus, catalogId: number): number | null {
  return status === 'retired' ? null : catalogId;
}

/** Saída do armazém, espelho de serviceInstall. Recusa o que não há. */
function debitStock(db: Database.Database, catalogId: number, name: string, actorId: number | null): void {
  const catalog = db.prepare(`
    SELECT stock_total AS stockTotal, ${LANDED_COST_SQL} AS landedCostCve
    FROM equipment_catalog WHERE id = ?
  `).get(catalogId) as { stockTotal: number; landedCostCve: number } | undefined;
  if (!catalog) throw new BackboneValidationError('Catálogo não encontrado');
  if (catalog.stockTotal < 1) {
    throw new BackboneValidationError(`Stock insuficiente. Disponivel: ${catalog.stockTotal}`);
  }
  db.prepare(`
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, reference, created_by)
    VALUES (?, 'saida', 1, ?, ?, ?)
  `).run(catalogId, catalog.landedCostCve, `Backbone ${name}`, actorId);
  db.prepare(`
    UPDATE equipment_catalog
    SET stock_total = stock_total - 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(catalogId);
}

/** Regresso ao armazém: a unidade sai de serviço, ou troca de modelo. */
function creditStock(db: Database.Database, catalogId: number, name: string, actorId: number | null): void {
  const catalog = db.prepare(`SELECT ${LANDED_COST_SQL} AS landedCostCve FROM equipment_catalog WHERE id = ?`)
    .get(catalogId) as { landedCostCve: number } | undefined;
  db.prepare(`
    INSERT INTO stock_movements (catalog_id, type, quantity, unit_cost_cve, reference, created_by)
    VALUES (?, 'devolucao', 1, ?, ?, ?)
  `).run(catalogId, catalog?.landedCostCve ?? 0, `Backbone ${name}`, actorId);
  db.prepare(`
    UPDATE equipment_catalog
    SET stock_total = stock_total + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(catalogId);
}

/**
 * Cada alimentação tem de existir, estar em serviço e não fechar um ciclo.
 * Lista vazia é válida: a unidade recebe directamente da Internet.
 *
 * O ciclo procura-se com uma travessia em profundidade a partir dos candidatos,
 * com conjunto de visitados — num grafo há vários caminhos até à raiz, e subir
 * um só (como fazia a versão de coluna única) deixava passar o ciclo fechado
 * pelo segundo. O conjunto garante que a travessia termina mesmo com dados já
 * em ciclo, sem precisar de tecto de profundidade.
 *
 * `id` é null na criação — uma unidade acabada de criar ainda não alimenta
 * ninguém, logo não pode fechar nada.
 */
function ensureUpstreams(
  db: Database.Database,
  id: number | null,
  upstreamDeviceIds: number[]
): void {
  if (upstreamDeviceIds.length === 0) return;
  const statusOf = db.prepare('SELECT status FROM backbone_devices WHERE id = ?');
  for (const upstreamId of upstreamDeviceIds) {
    if (id !== null && upstreamId === id) {
      throw new BackboneValidationError('Um backbone não pode alimentar-se a si próprio');
    }
    const upstream = statusOf.get(upstreamId) as { status: BackboneStatus } | undefined;
    if (!upstream) throw new BackboneValidationError('Backbone a montante não encontrado');
    if (upstream.status === 'retired') {
      throw new BackboneValidationError('Não é possível ser alimentado por um backbone retirado');
    }
  }
  if (id === null) return;
  const parentsOf = db.prepare('SELECT upstream_device_id AS upstream FROM backbone_links WHERE device_id = ?');
  const visited = new Set<number>();
  const pending = [...upstreamDeviceIds];
  while (pending.length > 0) {
    const current = pending.pop() as number;
    if (current === id) {
      throw new BackboneValidationError('Esta ligação criaria um ciclo na cadeia de backbones');
    }
    if (visited.has(current)) continue;
    visited.add(current);
    for (const row of parentsOf.all(current) as Array<{ upstream: number }>) {
      pending.push(row.upstream);
    }
  }
}

function downstreamExists(db: Database.Database, id: number): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM backbone_links link
    JOIN backbone_devices dev ON dev.id = link.device_id
    WHERE link.upstream_device_id = ? AND dev.status <> 'retired'
  `).get(id));
}

function normalizeInput(input: BackboneWriteInput): Omit<BackboneWriteInput, 'expectedUpdatedAt'> & { expectedUpdatedAt?: string } {
  const name = normalizeOptional(input.name);
  if (!name) throw new BackboneValidationError('Nome do backbone é obrigatório');
  if (!Number.isInteger(input.catalogId) || input.catalogId <= 0) {
    throw new BackboneValidationError('Catálogo inválido');
  }
  if (!BACKBONE_STATUSES.has(input.status)) {
    throw new BackboneValidationError('Estado do backbone inválido');
  }
  const upstreamDeviceIds = [...new Set(input.upstreamDeviceIds ?? [])];
  if (upstreamDeviceIds.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new BackboneValidationError('Backbone a montante inválido');
  }
  return {
    ...input,
    name,
    upstreamDeviceIds,
    serialNumber: normalizeOptional(input.serialNumber),
    assetTag: normalizeOptional(input.assetTag),
    ipAddress: normalizeOptional(input.ipAddress),
    macAddress: normalizeMac(input.macAddress),
    island: normalizeOptional(input.island),
    zone: normalizeOptional(input.zone),
    notes: normalizeOptional(input.notes),
    expectedUpdatedAt: normalizeOptional(input.expectedUpdatedAt ?? null) ?? undefined
  };
}

function nextUpdatedAt(current: string): string {
  const now = new Date();
  const currentTime = Date.parse(current.replace(' ', 'T') + (current.includes('T') ? '' : 'Z'));
  if (Number.isFinite(currentTime) && now.getTime() <= currentTime) {
    now.setTime(currentTime + 1);
  }
  return now.toISOString();
}

function handleSqlError(error: unknown): never {
  if (error instanceof BackboneValidationError || error instanceof BackboneNotFoundError || error instanceof BackboneConflictError) throw error;
  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    throw new BackboneConflictError('Serial ou etiqueta de ativo já pertence a outro backbone ativo');
  }
  throw error;
}

export function listBackbones(
  db: Database.Database,
  query: BackboneListQuery
): BackbonePage<BackboneDeviceSummary> {
  const params: unknown[] = [];
  const normalizedQuery = normalizeQuery(query.query);
  let where = 'WHERE 1 = 1';
  if (query.status) {
    where += ' AND bd.status = ?';
    params.push(query.status);
  }
  if (query.upstreamDeviceId !== undefined) {
    where += ` AND EXISTS (
      SELECT 1 FROM backbone_links link
      WHERE link.device_id = bd.id AND link.upstream_device_id = ?
    )`;
    params.push(query.upstreamDeviceId);
  }
  where += backboneSearchClause(normalizedQuery, params);
  const from = `
    FROM backbone_devices bd
    JOIN equipment_catalog ec ON ec.id = bd.catalog_id
    LEFT JOIN backbone_assignment_links active_link
      ON active_link.backbone_device_id = bd.id AND active_link.ended_at IS NULL`;
  const total = Number((db.prepare(`SELECT COUNT(DISTINCT bd.id) AS count ${from} ${where}`).get(...params) as { count: number }).count);
  const bounds = pageBounds(query.page, query.pageSize, total);
  const items = db.prepare(`
    SELECT ${BACKBONE_COLUMNS} ${from} ${where}
    GROUP BY bd.id
    ORDER BY bd.name COLLATE NOCASE, bd.id
    LIMIT ? OFFSET ?
  `).all(...params, bounds.pageSize, (bounds.page - 1) * bounds.pageSize) as BackboneRow[];
  const upstreams = upstreamsByDevice(db, items.map((item) => item.id));
  return {
    ...bounds,
    total,
    items: items.map((item) => backboneFromRow(item, upstreams.get(item.id) ?? []))
  };
}

export function listAssignments(
  db: Database.Database,
  query: AssignmentListQuery
): BackbonePage<BackboneAssignmentSummary> {
  const params: unknown[] = [];
  let where = 'WHERE a.end_date IS NULL';
  let cte = '';
  if (query.mapping === 'linked') where += ' AND link.id IS NOT NULL';
  /*
   * "Por ligar" é quem ainda pode vir a ligar-se: só a antena/CPE fala com o
   * backbone, e mesmo essa deixa de estar à espera quando já está instalada a
   * jusante de outra — o ponto de acesso na segunda saída da antena do cliente
   * é uma antena sem link que ninguém vai ligar ao backbone. Contá-los dava uma
   * dívida impossível de saldar. `linked` fica completa de propósito: uma
   * ligação antiga a um router tem de continuar visível para se poder desfazer.
   */
  if (query.mapping === 'unlinked') {
    cte = PLACEMENT_CTE;
    where += ` AND link.id IS NULL AND ec.type IN (${BACKBONE_UPLINK_TYPES_SQL})
      AND a.id NOT IN (
        SELECT assignmentId FROM placement WHERE parentAssignmentId IS NOT NULL
      )`;
  }
  if (query.backboneDeviceId !== undefined) {
    where += ' AND link.backbone_device_id = ?';
    params.push(query.backboneDeviceId);
  }
  where += assignmentSearchClause(normalizeQuery(query.query), params);
  const from = `
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN backbone_assignment_links link ON link.assignment_id = a.id AND link.ended_at IS NULL
    LEFT JOIN backbone_devices bd ON bd.id = link.backbone_device_id`;
  const total = Number((db.prepare(`${cte} SELECT COUNT(*) AS count ${from} ${where}`).get(...params) as { count: number }).count);
  const bounds = pageBounds(query.page, query.pageSize, total);
  const items = db.prepare(`
    ${cte}
    SELECT ${ASSIGNMENT_COLUMNS} ${from} ${where}
    ORDER BY c.full_name COLLATE NOCASE, a.id
    LIMIT ? OFFSET ?
  `).all(...params, bounds.pageSize, (bounds.page - 1) * bounds.pageSize) as AssignmentRow[];
  return { ...bounds, total, items: items.map(assignmentFromRow) };
}

export function getBackbone(db: Database.Database, id: number): BackboneDeviceDetail | null {
  const row = db.prepare(`
    SELECT ${BACKBONE_COLUMNS}, bd.notes
    FROM backbone_devices bd
    JOIN equipment_catalog ec ON ec.id = bd.catalog_id
    LEFT JOIN backbone_assignment_links active_link
      ON active_link.backbone_device_id = bd.id AND active_link.ended_at IS NULL
    WHERE bd.id = ?
    GROUP BY bd.id
  `).get(id) as (BackboneRow & { notes: string | null }) | undefined;
  if (!row) return null;
  const assignments = listAssignments(db, {
    mapping: 'linked', backboneDeviceId: id, page: 1, pageSize: 100
  }).items;
  // Retiradas ficam de fora, como no mapa ativo (ADR 0005) e como em
  // `downstreamCount`. O filtro cru de `listBackbones` não decide isso.
  const downstream = listBackbones(db, {
    upstreamDeviceId: id, page: 1, pageSize: 100
  }).items.filter((unit) => unit.status !== 'retired');
  const upstreams = upstreamsByDevice(db, [id]).get(id) ?? [];
  return { ...backboneFromRow(row, upstreams), notes: row.notes, assignments, downstream };
}

export function createBackbone(
  db: Database.Database,
  input: BackboneWriteInput,
  actorId: number | null
): BackboneDeviceDetail {
  const normalized = normalizeInput(input);
  ensureCatalog(db, normalized.catalogId);
  ensureUpstreams(db, null, normalized.upstreamDeviceIds);
  // A unidade e as suas alimentações entram juntas: um backbone gravado sem as
  // ligações apareceria por instantes pendurado na Internet.
  const create = db.transaction(() => {
    const holder = stockHolder(normalized.status, normalized.catalogId);
    if (holder !== null) {
      debitStock(db, holder, normalized.name, actorId);
    }
    const result = db.prepare(`
      INSERT INTO backbone_devices (
        catalog_id, name, status, serial_number, asset_tag, ip_address, mac_address,
        island, zone, notes, created_by, provisional
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      normalized.catalogId, normalized.name, normalized.status, normalized.serialNumber,
      normalized.assetTag, normalized.ipAddress, normalized.macAddress, normalized.island,
      normalized.zone, normalized.notes, actorId
    );
    const createdId = Number(result.lastInsertRowid);
    replaceUpstreams(db, createdId, normalized.upstreamDeviceIds, actorId);
    return createdId;
  });
  try {
    const created = getBackbone(db, create());
    if (!created) throw new BackboneNotFoundError('Backbone criado não encontrado');
    return created;
  } catch (error) {
    return handleSqlError(error);
  }
}

export function updateBackbone(
  db: Database.Database,
  id: number,
  input: BackboneWriteInput,
  actorId: number | null
): BackboneDeviceDetail {
  const normalized = normalizeInput(input);
  ensureCatalog(db, normalized.catalogId);
  const update = db.transaction(() => {
    const existing = db.prepare(`
      SELECT updated_at AS updatedAt, catalog_id AS catalogId, status, name
      FROM backbone_devices WHERE id = ?
    `).get(id) as { updatedAt: string; catalogId: number; status: BackboneStatus; name: string } | undefined;
    if (!existing) throw new BackboneNotFoundError('Backbone não encontrado');
    if (normalized.expectedUpdatedAt && normalized.expectedUpdatedAt !== existing.updatedAt) {
      throw new BackboneConflictError('O backbone foi alterado por outra pessoa');
    }
    ensureUpstreams(db, id, normalized.upstreamDeviceIds);
    if (normalized.status === 'retired') {
      const activeLink = db.prepare(`
        SELECT id FROM backbone_assignment_links WHERE backbone_device_id = ? AND ended_at IS NULL
      `).get(id);
      if (activeLink) throw new BackboneValidationError('Desvincule ou transfira os equipamentos antes de retirar o backbone');
      if (downstreamExists(db, id)) {
        throw new BackboneValidationError('Reencaminhe os backbones alimentados por esta unidade antes de a retirar');
      }
    }
    const result = db.prepare(`
      UPDATE backbone_devices SET
        catalog_id = ?, name = ?, status = ?, serial_number = ?, asset_tag = ?,
        ip_address = ?, mac_address = ?, island = ?, zone = ?, notes = ?,
        updated_at = ?
      WHERE id = ? AND (? IS NULL OR updated_at = ?)
        AND (? <> 'retired' OR NOT EXISTS (
          SELECT 1 FROM backbone_assignment_links
          WHERE backbone_device_id = backbone_devices.id AND ended_at IS NULL
        ))
    `).run(
      normalized.catalogId, normalized.name, normalized.status, normalized.serialNumber,
      normalized.assetTag, normalized.ipAddress, normalized.macAddress, normalized.island,
      normalized.zone, normalized.notes,
      nextUpdatedAt(existing.updatedAt), id,
      normalized.expectedUpdatedAt ?? null, normalized.expectedUpdatedAt ?? null, normalized.status
    );
    if (result.changes === 0) {
      const activeLink = normalized.status === 'retired' && db.prepare(`
        SELECT id FROM backbone_assignment_links WHERE backbone_device_id = ? AND ended_at IS NULL
      `).get(id);
      if (activeLink) throw new BackboneValidationError('Desvincule ou transfira os equipamentos antes de retirar o backbone');
      throw new BackboneConflictError('O backbone foi alterado por outra pessoa');
    }
    // O stock segue o par (modelo, em serviço). Um só cálculo cobre retirar,
    // reactivar, trocar de modelo, e trocar dos dois ao mesmo tempo; uma edição
    // de nome ou de IP não mexe em nada, que é o que impede o duplo desconto.
    const before = stockHolder(existing.status, existing.catalogId);
    const after = stockHolder(normalized.status, normalized.catalogId);
    if (before !== after) {
      if (before !== null) creditStock(db, before, existing.name, actorId);
      if (after !== null) debitStock(db, after, normalized.name, actorId);
    }
    replaceUpstreams(db, id, normalized.upstreamDeviceIds, actorId);
  });
  try {
    update();
    const updated = getBackbone(db, id);
    if (!updated) throw new BackboneNotFoundError('Backbone não encontrado');
    return updated;
  } catch (error) {
    return handleSqlError(error);
  }
}

export function setAssignmentBackbone(
  db: Database.Database,
  assignmentId: number,
  input: AssignmentBackboneInput,
  actorId: number | null
): BackboneAssignmentSummary {
  if (!Number.isInteger(input.backboneDeviceId) || input.backboneDeviceId <= 0) {
    throw new BackboneValidationError('Backbone inválido');
  }
  const reason = normalizeOptional(input.reason);
  const transfer = db.transaction(() => {
    const assignmentRow = activeAssignmentRow(db, assignmentId);
    /*
     * Só a antena/CPE do cliente fala com o backbone. O router de casa liga-se
     * a essa antena, e o mapa coloca-o lá sozinho — pendurá-lo na antena do
     * backbone desenhava-o ao lado do CPE e o cliente aparecia duas vezes.
     */
    if (!(BACKBONE_UPLINK_TYPES as readonly string[]).includes(assignmentRow.catalogType)) {
      throw new BackboneValidationError(
        'Só antenas e CPE ligam ao backbone; o resto do equipamento pende da antena do cliente'
      );
    }
    const backbone = db.prepare('SELECT id, status FROM backbone_devices WHERE id = ?').get(input.backboneDeviceId) as { id: number; status: BackboneStatus } | undefined;
    if (!backbone) throw new BackboneNotFoundError('Backbone não encontrado');
    if (backbone.status === 'retired') throw new BackboneValidationError('Não é possível associar um backbone retirado');
    const current = db.prepare(`
      SELECT id, backbone_device_id AS backboneDeviceId FROM backbone_assignment_links
      WHERE assignment_id = ? AND ended_at IS NULL
    `).get(assignmentId) as { id: number; backboneDeviceId: number } | undefined;
    if (current?.backboneDeviceId !== input.backboneDeviceId) {
      if (current) {
        db.prepare(`
          UPDATE backbone_assignment_links
          SET ended_at = datetime('now'), ended_by = ?, change_reason = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(actorId, reason, current.id);
      }
      db.prepare(`
        INSERT INTO backbone_assignment_links (backbone_device_id, assignment_id, change_reason, created_by)
        VALUES (?, ?, ?, ?)
      `).run(input.backboneDeviceId, assignmentId, reason, actorId);
    }
  });
  try {
    transfer();
    const assignment = listAssignments(db, {
      mapping: 'linked', backboneDeviceId: input.backboneDeviceId, page: 1, pageSize: 100
    }).items.find((item) => item.id === assignmentId);
    if (!assignment) throw new BackboneNotFoundError('Atribuição associada não encontrada');
    return assignment;
  } catch (error) {
    return handleSqlError(error);
  }
}

export function clearAssignmentBackbone(
  db: Database.Database,
  assignmentId: number,
  reason: string | null,
  actorId: number | null
): void {
  const clear = db.transaction(() => {
    activeAssignmentRow(db, assignmentId);
    const result = db.prepare(`
      UPDATE backbone_assignment_links
      SET ended_at = datetime('now'), ended_by = ?, change_reason = ?, updated_at = datetime('now')
      WHERE assignment_id = ? AND ended_at IS NULL
    `).run(actorId, normalizeOptional(reason), assignmentId);
    if (result.changes === 0) throw new BackboneNotFoundError('Ligação ativa não encontrada');
  });
  try {
    clear();
  } catch (error) {
    handleSqlError(error);
  }
}

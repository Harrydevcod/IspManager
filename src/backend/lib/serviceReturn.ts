import type Database from 'better-sqlite3';
import { factMoment } from '../../shared/assignment-dates';
import { sharerServices } from './deviceShares';
import { cleanValue, loadCatalogIdentity } from './serviceInstall';

/**
 * O contrário da instalação: fechar o que ficou em casa do cliente.
 *
 * O momento em que isto interessa é o cancelamento — o cliente devolve a antena
 * e o router, o técnico recupera o cabo que der, e o resto perdeu-se. Três
 * regras que este ficheiro põe por escrito:
 *
 * 1. **O que corta a renda é `end_date`, não o estado da unidade.** Devolvido,
 *    partido ou nunca visto — a partir daqui não há mais linha de aluguer.
 * 2. **Só 'bom' repõe stock.** A unidade saiu do armazém na instalação
 *    (movimento `saida`); se não volta em condições de ser instalada outra vez,
 *    não se escreve movimento nenhum e o custo fica onde já estava.
 * 3. **Material é parcial.** Recupera-se o que se conseguir, nunca mais do que
 *    o que foi consumido menos o que já se recuperou antes.
 */

export type ReturnCondition = 'bom' | 'avariado' | 'nao_devolvido';

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  bom: 'Bom estado',
  avariado: 'Avariado',
  nao_devolvido: 'Nao devolvido'
};

export type DeviceReturnInput = {
  assignmentId: number;
  condition?: ReturnCondition | null;
  notes?: string | null;
};

export type MaterialReturnInput = {
  catalogId: number;
  quantity: number;
  notes?: string | null;
};

type AssignmentRow = {
  id: number;
  serviceId: number;
  catalogId: number;
  endDate: string | null;
  ownership: string;
};

/**
 * Fecha uma atribuição dentro de uma transação já aberta. Devolve o stock só
 * quando a unidade volta em condições de ser reinstalada.
 */
export function returnAssignmentWithinTx(
  db: Database.Database,
  params: {
    assignmentId: number;
    serviceId?: number;
    clientName: string;
    condition?: ReturnCondition | null;
    notes?: string | null;
    technicianId?: number | null;
    userId: number | null;
    skipEvent?: boolean;
    /** Dia em que a unidade saiu mesmo. Sem valor, e hoje. */
    returnedOn?: string | null;
    /**
     * A unidade sai porque outra ocupa o lugar dela, não porque foi removida.
     * Só o chamador sabe garantir a continuidade — e tem de a garantir na mesma
     * transação, ou os partilhados ficam mesmo às escuras.
     */
    replacing?: boolean;
  }
): { assignmentId: number; condition: ReturnCondition; restoredStock: boolean; eventId: number | bigint } {
  const condition: ReturnCondition = params.condition ?? 'bom';
  const notes = cleanValue(params.notes);
  // O dia da recolha e o do facto; `updated_at` continua a marcar o lancamento.
  const moment = factMoment(params.returnedOn);

  const current = db.prepare(`
    SELECT id, service_id AS serviceId, catalog_id AS catalogId, end_date AS endDate, ownership
    FROM service_device_assignments
    WHERE id = ?
  `).get(params.assignmentId) as AssignmentRow | undefined;

  if (!current) {
    throw new Error('assignment_missing');
  }
  if (params.serviceId && current.serviceId !== params.serviceId) {
    throw new Error('assignment_other_service');
  }
  if (current.endDate) {
    throw new Error('already_closed');
  }

  // Devolver é remoção física: os serviços partilhados ficariam sem sinal. O
  // operador desassocia-os primeiro — promover um deles a titular em silêncio
  // seria esperto de mais para as 3 da manhã.
  if (!params.replacing) {
    const sharers = sharerServices(db, params.assignmentId);
    if (sharers.length > 0) {
      throw new Error(`device_shared:${sharers.map((sharer) => sharer.clientName).join(', ')}`);
    }
  }

  const updated = db.prepare(`
    UPDATE service_device_assignments
    SET end_date = ?,
        return_condition = ?,
        updated_at = datetime('now')
    WHERE id = ? AND end_date IS NULL
  `).run(moment.day, condition, params.assignmentId);
  if (updated.changes === 0) {
    throw new Error('already_closed');
  }

  db.prepare(`
    UPDATE backbone_assignment_links
    SET ended_at = ?,
        ended_by = ?,
        change_reason = COALESCE(change_reason, 'assignment_closed'),
        updated_at = datetime('now')
    WHERE assignment_id = ? AND ended_at IS NULL
  `).run(moment.at, params.userId ?? params.technicianId ?? null, params.assignmentId);

  // Espelho da instalacao: o que e do cliente nunca saiu do armazem, por isso
  // tambem nao volta a ele — inflar o stock com equipamento alheio seria pior do
  // que nao registar nada.
  const restoredStock = condition === 'bom' && current.ownership !== 'cliente';
  if (restoredStock) {
    const catalog = loadCatalogIdentity(db, current.catalogId);
    db.prepare(`
      INSERT INTO stock_movements (
        catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by, created_at
      )
      VALUES (?, 'devolucao', 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.catalogId,
      catalog?.landedCostCve ?? 0,
      `Devolucao servico ${current.serviceId}`,
      notes,
      current.serviceId,
      params.clientName,
      params.userId,
      moment.at
    );

    db.prepare(`
      UPDATE equipment_catalog
      SET stock_total = stock_total + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(current.catalogId);
  }

  let eventId: number | bigint = 0;
  if (!params.skipEvent) {
    const event = db.prepare(`
      INSERT INTO service_events (
        service_id, event_type, notes, technician_id, created_by, created_at
      )
      VALUES (?, 'alteracao_servico', ?, ?, ?, ?)
    `).run(
      current.serviceId,
      notes ?? `Devolucao de equipamento (${RETURN_CONDITION_LABELS[condition].toLowerCase()})`,
      params.technicianId ?? null,
      params.userId ?? params.technicianId ?? null,
      moment.at
    );
    eventId = event.lastInsertRowid;
  }

  return { assignmentId: params.assignmentId, condition, restoredStock, eventId };
}

/** Quanto deste material ainda pode ser recuperado neste serviço. */
export function pendingMaterialQuantity(db: Database.Database, serviceId: number, catalogId: number): number {
  const row = db.prepare(`
    SELECT
      COALESCE((
        SELECT SUM(quantity) FROM service_material_lines
        WHERE service_id = ? AND catalog_id = ?
      ), 0) AS consumed,
      COALESCE((
        SELECT SUM(quantity) FROM stock_movements
        WHERE service_id = ? AND catalog_id = ? AND type = 'devolucao'
      ), 0) AS recovered
  `).get(serviceId, catalogId, serviceId, catalogId) as { consumed: number; recovered: number };
  return Math.max(0, row.consumed - row.recovered);
}

/**
 * Devolve ao armazém o material que o técnico conseguiu recuperar. Espelho do
 * `consumeMaterialWithinTx`, com o tecto no que foi realmente consumido aqui.
 */
export function recoverMaterialWithinTx(
  db: Database.Database,
  params: {
    serviceId: number;
    clientName: string;
    catalogId: number;
    quantity: number;
    notes?: string | null;
    userId: number | null;
    /** Dia em que o material foi mesmo recuperado. Sem valor, e hoje. */
    returnedOn?: string | null;
  }
): { quantity: number } {
  const quantity = Number(params.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('recover_invalid_quantity');
  }

  const catalog = loadCatalogIdentity(db, params.catalogId);
  if (!catalog) {
    throw new Error('catalog_missing');
  }

  const pending = pendingMaterialQuantity(db, params.serviceId, params.catalogId);
  if (quantity > pending) {
    throw new Error(`recover_exceeds:${pending}`);
  }

  db.prepare(`
    INSERT INTO stock_movements (
      catalog_id, type, quantity, unit_cost_cve, reference, notes, service_id, client_name, created_by, created_at
    )
    VALUES (?, 'devolucao', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.catalogId,
    quantity,
    catalog.landedCostCve,
    `Devolucao servico ${params.serviceId}`,
    cleanValue(params.notes),
    params.serviceId,
    params.clientName,
    params.userId,
    factMoment(params.returnedOn).at
  );

  db.prepare(`
    UPDATE equipment_catalog
    SET stock_total = stock_total + ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(quantity, params.catalogId);

  return { quantity };
}

export type ServiceReturnResult = {
  devices: Array<{ assignmentId: number; condition: ReturnCondition; restoredStock: boolean }>;
  materials: Array<{ catalogId: number; quantity: number }>;
  eventId: number | bigint;
};

/**
 * O lote inteiro numa transação: ou o serviço fica todo fechado, ou nada muda.
 * Uma antena partilhada a meio do lote desfaz tudo — o operador trata das
 * partilhas e volta, em vez de ficar com metade do material devolvido.
 */
export function processServiceReturn(
  db: Database.Database,
  params: {
    serviceId: number;
    clientName: string;
    devices: DeviceReturnInput[];
    materials: MaterialReturnInput[];
    technicianId?: number | null;
    notes?: string | null;
    userId: number | null;
    /** Dia da recolha, comum a todo o lote: e uma visita, nao varias. */
    returnedOn?: string | null;
  }
): ServiceReturnResult {
  const devices: ServiceReturnResult['devices'] = [];
  const materials: ServiceReturnResult['materials'] = [];

  for (const device of params.devices) {
    const result = returnAssignmentWithinTx(db, {
      assignmentId: device.assignmentId,
      serviceId: params.serviceId,
      clientName: params.clientName,
      condition: device.condition,
      notes: device.notes,
      technicianId: params.technicianId,
      userId: params.userId,
      skipEvent: true,
      returnedOn: params.returnedOn
    });
    devices.push({
      assignmentId: result.assignmentId,
      condition: result.condition,
      restoredStock: result.restoredStock
    });
  }

  for (const material of params.materials) {
    const result = recoverMaterialWithinTx(db, {
      serviceId: params.serviceId,
      clientName: params.clientName,
      catalogId: material.catalogId,
      quantity: material.quantity,
      notes: material.notes,
      userId: params.userId,
      returnedOn: params.returnedOn
    });
    materials.push({ catalogId: material.catalogId, quantity: result.quantity });
  }

  const event = db.prepare(`
    INSERT INTO service_events (service_id, event_type, notes, technician_id, created_by, created_at)
    VALUES (?, 'alteracao_servico', ?, ?, ?, ?)
  `).run(
    params.serviceId,
    summarizeReturn(devices, materials, params.notes),
    params.technicianId ?? null,
    params.userId ?? params.technicianId ?? null,
    factMoment(params.returnedOn).at
  );

  return { devices, materials, eventId: event.lastInsertRowid };
}

/** A frase que fica na história do cliente. É o que se lê ao telefone. */
export function summarizeReturn(
  devices: ServiceReturnResult['devices'],
  materials: ServiceReturnResult['materials'],
  notes?: string | null
): string {
  const parts: string[] = [];
  if (devices.length > 0) {
    const lost = devices.filter((device) => device.condition !== 'bom');
    const detail = lost.length > 0
      ? ` (${lost.map((device) => RETURN_CONDITION_LABELS[device.condition].toLowerCase()).join(', ')})`
      : '';
    parts.push(`${devices.length} equipamento(s) devolvido(s)${detail}`);
  }
  const recovered = materials.reduce((sum, material) => sum + material.quantity, 0);
  if (recovered > 0) {
    parts.push(`${recovered} un de material recuperado`);
  }
  const summary = `Devolucao: ${parts.length > 0 ? parts.join('; ') : 'sem itens'}`;
  const extra = cleanValue(notes);
  return extra ? `${summary}. ${extra}` : summary;
}

/** Traduz os erros do motor para respostas HTTP, no molde do `mapInstallError`. */
export function mapReturnError(error: unknown): { status: number; error: string } | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error.message === 'assignment_missing') {
    return { status: 404, error: 'Atribuicao nao encontrada' };
  }
  if (error.message === 'assignment_other_service') {
    return { status: 400, error: 'Atribuicao de outro servico' };
  }
  if (error.message === 'already_closed') {
    return { status: 400, error: 'Atribuicao ja encerrada' };
  }
  if (error.message.startsWith('device_shared:')) {
    const names = error.message.slice('device_shared:'.length);
    return {
      status: 409,
      error: `Esta antena serve tambem ${names.split(', ').length} servico(s): ${names}. Remova as partilhas primeiro.`
    };
  }
  if (error.message === 'catalog_missing') {
    return { status: 404, error: 'Artigo nao encontrado' };
  }
  if (error.message === 'recover_invalid_quantity') {
    return { status: 400, error: 'Quantidade recuperada invalida' };
  }
  if (error.message.startsWith('recover_exceeds:')) {
    return {
      status: 400,
      error: `Quantidade acima do que foi consumido neste servico. Por recuperar: ${error.message.split(':')[1]}`
    };
  }
  return null;
}

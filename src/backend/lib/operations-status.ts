import type Database from 'better-sqlite3';
import { getSqliteDatabase } from '../db/database';
import { listBackups } from './backup';
import { INSTALLED_UNITS_SQL, landedCostSql } from './capex';
import { buildProposals, dismissalKey, type ProposalKind } from './discovery-reconcile';
import { loadRegisteredDevices, loadSeenHosts } from './network-discovery';
import { jobHealth } from './jobRuns';
import { loadNetworkStatus } from './network-probe';
import { balanceSqlExpr, overdueSqlPredicate } from './payments';
import { formatPtDateTime, parseDate } from '../../shared/date';
import { DEFAULT_POSTPAID_BILLING_DAY } from '../../shared/billing-period';
import {
  worstSeverity,
  type OperationsAccessLayer,
  type OperationsAction,
  type OperationsBackboneNode,
  type OperationsBilling,
  type OperationsCollectionCycle,
  type OperationsCompliance,
  type OperationsCustomers,
  type OperationsDebtor,
  type OperationsFinding,
  type OperationsFleet,
  type OperationsFleetModel,
  type OperationsMessaging,
  type OperationsNetwork,
  type OperationsRisk,
  type OperationsSeverity,
  type OperationsStatus,
  type OperationsSystem
} from '../../shared/operations-status';

/**
 * Estado da operação — leitura viva, calculada a cada pedido.
 *
 * Sem cache: em SQLite local o custo é de milissegundos, e um painel de
 * monitorização que serve dados de há cinco minutos mente exatamente quando
 * mais importa acertar. A única concessão é a janela temporal, fixada uma vez
 * por chamada para que todas as secções contem o mesmo intervalo.
 */

/** Um único equipamento acima disto e o negócio está pendurado nele. */
const CONCENTRATION_THRESHOLD = 0.25;
/** Abaixo desta taxa um ciclo de cobrança deixou de ser ruído. */
const COLLECTION_WARN = 0.8;
const COLLECTION_CRITICAL = 0.6;
/** Um backup mais velho do que isto deixou de ser proteção. */
const BACKUP_STALE_HOURS = 48;
/** Dias de atraso a partir dos quais a dívida deixa de se resolver sozinha. */
const OVERDUE_CRITICAL_DAYS = 30;
/** Erros do provedor que significam "a conta está parada", não "a rede oscilou". */
const PROVIDER_BLOCK_PATTERNS = ['non-payment', 'subscription', 'expired', 'quota', 'suspended', 'unauthorized'];

type Settings = Record<string, string>;

function loadSettings(db: Database.Database): Settings {
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cve(value: number): string {
  return `${Math.round(value).toLocaleString('pt-PT')} CVE`;
}

// ------------------------------------------------------------------ rede

/**
 * O universo dos dois eixos do equipamento: tudo o que está de pé, em campo ou
 * no backbone. `wan_mode` (0056) e `operation_mode` (0057) vivem nas duas
 * tabelas, e nenhuma das migrações fez backfill — de propósito, porque adivinhar
 * o modo a partir do nome do modelo é como se perdia a informação da primeira
 * vez. Por isso o nulo conta-se como lacuna real.
 */
const MODE_UNIVERSE_SQL = `
  SELECT a.wan_mode AS wanMode, a.operation_mode AS operationMode
    FROM service_device_assignments a
   WHERE a.end_date IS NULL
  UNION ALL
  SELECT bd.wan_mode, bd.operation_mode
    FROM backbone_devices bd
   WHERE bd.status <> 'retired'`;

/**
 * Quantas propostas da descoberta estão prontas a aplicar.
 *
 * Conta-se, não se lista: o painel diz que há trabalho por fazer e a aba
 * Descoberta é que o mostra. Usa exatamente o mesmo preparo da rota
 * `/api/network/discovery/proposals` — se divergisse, o painel mandaria o
 * operador a um ecrã com outro número.
 */
function countDiscoveryProposals(db: Database.Database): number {
  const devices = loadRegisteredDevices(db);
  const hosts = loadSeenHosts(db);
  const dismissed = new Set(
    (db.prepare(`
      SELECT kind, target_kind AS targetKind, target_id AS targetId
      FROM network_discovery_dismissals
    `).all() as Array<{ kind: ProposalKind; targetKind: string; targetId: number }>)
      .map((row) => dismissalKey(row.kind, row.targetKind, row.targetId))
  );
  return buildProposals({ devices, hosts, dismissed }).length;
}

type BackboneAggregateRow = {
  backboneDeviceId: number;
  name: string;
  brand: string | null;
  model: string;
  ipAddress: string | null;
  zone: string | null;
  status: 'active' | 'maintenance';
  clientCount: number;
  serviceCount: number;
  mrrCve: number;
};

function loadNetwork(db: Database.Database): OperationsNetwork {
  // MRR por equipamento: cada serviço conta uma vez, mesmo servido por vários
  // equipamentos ligados ao mesmo backbone (DISTINCT no subselect, não SUM
  // direto — senão um cliente com CPE + router aparecia a dobrar).
  const rows = db.prepare(`
    SELECT
      bd.id AS backboneDeviceId,
      bd.name,
      ec.brand,
      ec.model,
      bd.ip_address AS ipAddress,
      bd.zone,
      bd.status,
      COALESCE(reach.clientCount, 0) AS clientCount,
      COALESCE(reach.serviceCount, 0) AS serviceCount,
      COALESCE(reach.mrrCve, 0) AS mrrCve
    FROM backbone_devices bd
    JOIN equipment_catalog ec ON ec.id = bd.catalog_id
    LEFT JOIN (
      SELECT
        d.backboneDeviceId,
        COUNT(DISTINCT d.clientId) AS clientCount,
        COUNT(DISTINCT d.serviceId) AS serviceCount,
        SUM(d.monthlyCve) AS mrrCve
      FROM (
        SELECT DISTINCT
          bal.backbone_device_id AS backboneDeviceId,
          s.id AS serviceId,
          s.client_id AS clientId,
          s.monthly_value_cve + s.audiovisual_monthly_cve AS monthlyCve
        FROM backbone_assignment_links bal
        JOIN service_device_assignments a ON a.id = bal.assignment_id AND a.end_date IS NULL
        JOIN assignment_services asv ON asv.assignment_id = a.id
        JOIN services s ON s.id = asv.service_id AND s.status = 'active'
        WHERE bal.ended_at IS NULL
      ) d
      GROUP BY d.backboneDeviceId
    ) reach ON reach.backboneDeviceId = bd.id
    WHERE bd.status <> 'retired'
    ORDER BY mrrCve DESC, bd.name COLLATE NOCASE
  `).all() as BackboneAggregateRow[];

  const uplinkRows = db.prepare(`
    SELECT link.device_id AS deviceId, up.name AS upstreamName
    FROM backbone_links link
    JOIN backbone_devices up ON up.id = link.upstream_device_id
    WHERE up.status <> 'retired'
  `).all() as Array<{ deviceId: number; upstreamName: string }>;
  const uplinks = new Map<number, string[]>();
  for (const row of uplinkRows) {
    const list = uplinks.get(row.deviceId);
    if (list) list.push(row.upstreamName);
    else uplinks.set(row.deviceId, [row.upstreamName]);
  }

  // Estado vivo da sonda ICMP, se estiver a correr. Indexado por equipamento
  // para o mapa e a lista lerem a mesma leitura.
  const probeStatus = loadNetworkStatus(db);
  const live = new Map(
    probeStatus.targets
      .filter((target) => target.kind === 'backbone')
      .map((target) => [target.id, target])
  );

  const attributedMrr = rows.reduce((sum, row) => sum + num(row.mrrCve), 0);
  const devices: OperationsBackboneNode[] = rows.map((row) => ({
    backboneDeviceId: row.backboneDeviceId,
    name: row.name,
    equipment: [row.brand, row.model].filter(Boolean).join(' '),
    ipAddress: row.ipAddress,
    zone: row.zone,
    status: row.status,
    upstreamNames: uplinks.get(row.backboneDeviceId) ?? [],
    clientCount: num(row.clientCount),
    serviceCount: num(row.serviceCount),
    mrrCve: num(row.mrrCve),
    mrrShare: share(num(row.mrrCve), attributedMrr),
    liveState: live.get(row.backboneDeviceId)?.state ?? null,
    liveSince: live.get(row.backboneDeviceId)?.since ?? null,
    uptime: live.get(row.backboneDeviceId)?.uptime ?? null
  }));

  // Raiz = equipamento sem uplink definido. Tudo o que está a jusante depende
  // dele, por isso a sua quota é a soma da árvore, não a sua própria.
  const roots = devices.filter((device) => device.upstreamNames.length === 0);
  const rootDevices = roots.map((root) => {
    const downstream = devices.filter((device) => device.upstreamNames.includes(root.name));
    const clientCount = downstream.reduce((sum, device) => sum + device.clientCount, root.clientCount);
    const mrrCve = downstream.reduce((sum, device) => sum + device.mrrCve, root.mrrCve);
    return { name: root.name, clientCount, mrrCve, mrrShare: share(mrrCve, attributedMrr) };
  });

  const servicesWithoutBackbone = db.prepare(`
    SELECT s.id AS serviceId, c.id AS clientId, c.full_name AS clientName, c.zone
    FROM services s
    JOIN clients c ON c.id = s.client_id
    WHERE s.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM assignment_services asv
        JOIN service_device_assignments a ON a.id = asv.assignment_id AND a.end_date IS NULL
        JOIN backbone_assignment_links bal ON bal.assignment_id = a.id AND bal.ended_at IS NULL
        WHERE asv.service_id = s.id
      )
    ORDER BY c.full_name COLLATE NOCASE
  `).all() as OperationsNetwork['servicesWithoutBackbone'];

  const identification = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM backbone_devices WHERE status <> 'retired') AS backboneTotal,
      (SELECT COUNT(*) FROM backbone_devices WHERE status <> 'retired' AND NULLIF(TRIM(ip_address), '') IS NOT NULL) AS backboneWithIp,
      (SELECT COUNT(*) FROM backbone_devices WHERE status <> 'retired' AND NULLIF(TRIM(mac_address), '') IS NOT NULL) AS backboneWithMac,
      (SELECT COUNT(*) FROM backbone_devices WHERE status <> 'retired' AND NULLIF(TRIM(serial_number), '') IS NOT NULL) AS backboneWithSerial,
      (SELECT COUNT(*) FROM service_device_assignments WHERE end_date IS NULL) AS assignmentTotal,
      (SELECT COUNT(*) FROM service_device_assignments WHERE end_date IS NULL AND NULLIF(TRIM(ip_address), '') IS NOT NULL) AS assignmentWithIp,
      (SELECT COUNT(*) FROM service_device_assignments WHERE end_date IS NULL AND NULLIF(TRIM(mac_address), '') IS NOT NULL) AS assignmentWithMac,
      (SELECT COUNT(*) FROM service_device_assignments WHERE end_date IS NULL AND NULLIF(TRIM(serial_number), '') IS NOT NULL) AS assignmentWithSerial,
      -- Identificado = tem por onde ser reconhecido, seja MAC ou série. Mesma
      -- regra do aviso na topologia; contar só MAC dizia que estava por
      -- identificar equipamento que tem a etiqueta legível e registada.
      (SELECT COUNT(*) FROM service_device_assignments
       WHERE end_date IS NULL AND (
         NULLIF(TRIM(mac_address), '') IS NOT NULL
         OR NULLIF(TRIM(serial_number), '') IS NOT NULL
       )) AS assignmentIdentified,
      -- Os dois eixos (0056/0057) contam-se sobre o mesmo universo: o que está
      -- de pé, em campo ou no backbone. Nulo é "por classificar", não um erro.
      (SELECT COUNT(*) FROM (${MODE_UNIVERSE_SQL}) m) AS modeTotal,
      (SELECT COUNT(*) FROM (${MODE_UNIVERSE_SQL}) m
        WHERE NULLIF(TRIM(COALESCE(m.wanMode, '')), '') IS NULL) AS withoutWanMode,
      (SELECT COUNT(*) FROM (${MODE_UNIVERSE_SQL}) m
        WHERE NULLIF(TRIM(COALESCE(m.operationMode, '')), '') IS NULL) AS withoutOperationMode
  `).get() as OperationsNetwork['identification'];

  const findings: OperationsFinding[] = [];

  for (const root of rootDevices) {
    if (root.mrrShare >= 0.9 && root.clientCount > 0) {
      findings.push({
        code: 'network.single-uplink',
        severity: 'red',
        title: `Uplink único: ${root.name}`,
        detail: `${pct(root.mrrShare)} da receita atribuída (${cve(root.mrrCve)}/mês, ${root.clientCount} clientes) passa por um só equipamento, sem alternativa definida.`
      });
    }
  }

  for (const device of devices) {
    if (device.mrrShare >= CONCENTRATION_THRESHOLD && device.upstreamNames.length > 0) {
      findings.push({
        code: 'network.concentration',
        severity: device.mrrShare >= 0.5 ? 'red' : 'amber',
        title: `Concentração em ${device.name}`,
        detail: `${device.clientCount} clientes e ${pct(device.mrrShare)} do MRR (${cve(device.mrrCve)}/mês) dependem deste equipamento.`
      });
    }
    if (device.status === 'maintenance') {
      findings.push({
        code: 'network.maintenance',
        severity: 'amber',
        title: `${device.name} em manutenção`,
        detail: `${device.clientCount} clientes servidos por um equipamento marcado como em manutenção.`
      });
    }
  }

  if (servicesWithoutBackbone.length > 0) {
    findings.push({
      code: 'network.unmapped-services',
      severity: 'amber',
      title: `${servicesWithoutBackbone.length} serviço(s) fora do mapa`,
      detail: `Ativos mas sem ligação a nenhum backbone: ${servicesWithoutBackbone.map((row) => row.clientName).join(', ')}. Numa avaria não há por onde começar.`
    });
  }

  // Abaixo de metade é registo em curso, não lacuna: quem está a classificar o
  // parque aos poucos não precisa de um aviso vermelho a cada passagem.
  const unclassified = Math.max(identification.withoutWanMode, identification.withoutOperationMode);
  if (identification.modeTotal > 0 && unclassified > identification.modeTotal / 2) {
    findings.push({
      code: 'network.unclassified-modes',
      severity: 'amber',
      title: `${unclassified} de ${identification.modeTotal} equipamentos por classificar`,
      detail: `${identification.withoutWanMode} sem modo de ligação e ${identification.withoutOperationMode} sem modo de operação.`
        + ' Sem os dois eixos não se sabe, a partir do registo, quem fala PPPoE nem quem faz de ponte — e cada visita ao terreno volta a descobri-lo.'
    });
  }

  if (identification.assignmentTotal > 0 && identification.assignmentWithMac === 0) {
    findings.push({
      code: 'network.no-mac',
      severity: 'amber',
      title: 'Nenhum equipamento em campo tem MAC registado',
      detail: `0 de ${identification.assignmentTotal} atribuições ativas. Sem MAC não se identifica um cliente a partir da rede, nem se deteta uma troca de equipamento.`
    });
  }

  // Equipamento em baixo é a única coisa nesta secção que se mede no presente:
  // vem à frente das restantes conclusões, ordenado por quem tem mais clientes.
  const down = devices
    .filter((device) => device.liveState === 'down')
    .sort((a, b) => b.clientCount - a.clientCount);
  for (const device of down) {
    findings.unshift({
      code: 'network.device-down',
      severity: device.clientCount > 0 ? 'red' : 'amber',
      title: `${device.name} não responde`,
      detail: `Sem resposta ao ping desde ${device.liveSince ? formatPtDateTime(device.liveSince) : 'a última leitura'}${device.clientCount > 0 ? ` — ${device.clientCount} cliente(s), ${cve(device.mrrCve)}/mês por trás` : ''}.`
    });
  }

  for (const device of devices) {
    if (device.liveState === 'up' && device.uptime !== null && device.uptime < 0.99 && device.clientCount > 0) {
      findings.push({
        code: 'network.flapping',
        severity: 'amber',
        title: `${device.name} instável`,
        detail: `${pct(device.uptime)} de disponibilidade no tempo observado. Uma ligação que cai e volta gasta-se em chamadas antes de se avariar de vez.`
      });
    }
  }

  return {
    devices,
    rootDevices,
    servicesWithoutBackbone,
    identification,
    discoveryProposals: countDiscoveryProposals(db),
    concentrationThreshold: CONCENTRATION_THRESHOLD,
    probe: {
      enabled: probeStatus.enabled,
      lastRunAt: probeStatus.lastRunAt,
      downCount: down.length,
      neverProbed: probeStatus.neverProbed
    },
    findings
  };
}

// -------------------------------------------------------------- clientes

/**
 * MRR = o que a geração mensal vai mesmo emitir, não a soma dos planos.
 *
 * Espelha `buildMonthlyServiceLines`, linha por linha:
 *  - plano e audiovisual **mensal** só ao serviço ativo;
 *  - aluguer do equipamento do ISP também ao **suspenso** — quem foi cortado e
 *    ficou com o router continua a pagá-lo até devolver;
 *  - cliente cancelado nunca conta, mesmo com o serviço por fechar.
 *
 * Sem isto o MRR ignorava o aluguer por inteiro e ficava abaixo do faturado.
 * `mrrActiveCve` é o denominador honesto do ARPU: receita dos ativos a dividir
 * por serviços ativos, sem a renda dos cortados pelo meio.
 */
function loadMrr(db: Database.Database): { mrrCve: number; mrrActiveCve: number } {
  return db.prepare(`
    SELECT
      COALESCE(SUM(mrr), 0) AS mrrCve,
      COALESCE(SUM(CASE WHEN status = 'active' THEN mrr ELSE 0 END), 0) AS mrrActiveCve
    FROM (
      SELECT
        s.status AS status,
        CASE WHEN s.status = 'active'
          THEN s.monthly_value_cve
             + CASE WHEN s.audiovisual_mode = 'monthly' THEN s.audiovisual_monthly_cve ELSE 0 END
          ELSE 0
        END
        + COALESCE((
            SELECT SUM(a.rental_fee_cve)
            FROM service_device_assignments a
            WHERE a.service_id = s.id AND a.end_date IS NULL AND a.ownership = 'isp'
          ), 0) AS mrr
      FROM services s
      JOIN clients c ON c.id = s.client_id
      WHERE s.status IN ('active', 'suspended') AND c.status != 'cancelled'
    )
  `).get() as { mrrCve: number; mrrActiveCve: number };
}

function loadCustomers(db: Database.Database, from: string, previousFrom: string): OperationsCustomers {
  const mrr = loadMrr(db);
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM clients WHERE status = 'active') AS active,
      (SELECT COUNT(*) FROM clients WHERE status = 'suspended') AS suspended,
      (SELECT COUNT(*) FROM clients WHERE status = 'cancelled') AS cancelled,
      -- Mesmo recorte do MRR: serviço ativo de cliente não cancelado. É o
      -- denominador do ARPU, tem de contar só o que está no numerador.
      (SELECT COUNT(*) FROM services s JOIN clients c ON c.id = s.client_id
        WHERE s.status = 'active' AND c.status != 'cancelled') AS activeServices,
      (SELECT COUNT(*) FROM clients WHERE date(created_at) >= @from) AS newClients,
      (SELECT COUNT(*) FROM clients WHERE date(created_at) >= @previousFrom AND date(created_at) < @from) AS newClientsPrevious,
      (SELECT COUNT(*) FROM services WHERE date(COALESCE(activation_date, created_at)) >= @from) AS activations,
      (SELECT COUNT(*) FROM clients WHERE status = 'cancelled' AND date(updated_at) >= @from) AS cancellations,
      (SELECT COUNT(*) FROM work_orders WHERE date(created_at) >= @from) AS workOrdersCreated,
      (SELECT COUNT(*) FROM work_orders WHERE completed_at IS NOT NULL AND date(completed_at) >= @from) AS workOrdersCompleted,
      (SELECT COUNT(*) FROM work_orders WHERE status NOT IN ('concluida','cancelada')) AS openWorkOrders,
      (SELECT COUNT(*) FROM service_events WHERE date(created_at) >= @from) AS serviceEvents,
      (SELECT COALESCE(SUM(p.amount_cve), 0)
         FROM payments p JOIN clients c ON c.id = p.client_id
        WHERE c.status = 'cancelled' AND p.status IN ('pending','overdue')) AS cancelledDebtCve
  `).get({ from, previousFrom }) as Record<string, number>;

  const zoneRows = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(zone), ''), '(sem zona)') AS zone, COUNT(*) AS clients
    FROM clients WHERE status = 'active'
    GROUP BY 1 ORDER BY clients DESC, zone COLLATE NOCASE
  `).all() as Array<{ zone: string; clients: number }>;
  const activeClients = num(totals.active);
  const zones = zoneRows.map((row) => ({
    zone: row.zone,
    clients: num(row.clients),
    share: share(num(row.clients), activeClients)
  }));

  // Serviços a preço abaixo da tabela do plano. É receita contratada e nunca
  // atualizada — a diferença é cobrável sem vender nada de novo.
  const uplift = db.prepare(`
    SELECT COUNT(*) AS services,
           COALESCE(SUM(p.monthly_price_cve - s.monthly_value_cve), 0) AS upliftCve
    FROM services s
    JOIN internet_plans p ON p.id = s.plan_id
    WHERE s.status = 'active' AND p.active = 1 AND s.monthly_value_cve < p.monthly_price_cve
  `).get() as { services: number; upliftCve: number };

  const findings: OperationsFinding[] = [];
  const topZone = zones[0];
  if (topZone && topZone.share >= CONCENTRATION_THRESHOLD && activeClients >= 5) {
    findings.push({
      code: 'customers.zone-concentration',
      severity: 'amber',
      title: `${pct(topZone.share)} dos clientes em ${topZone.zone}`,
      detail: `${topZone.clients} de ${activeClients} clientes ativos na mesma zona: uma falha local afeta-os a todos ao mesmo tempo.`
    });
  }
  if (num(uplift.services) > 0 && num(uplift.upliftCve) > 0) {
    findings.push({
      code: 'customers.below-plan-price',
      severity: 'amber',
      title: `${num(uplift.services)} serviço(s) abaixo do preço de tabela`,
      detail: `Alinhar com o plano vale ${cve(num(uplift.upliftCve))}/mês sem vender nada de novo.`
    });
  }
  if (num(totals.cancelledDebtCve) > 0) {
    findings.push({
      code: 'customers.cancelled-debt',
      severity: 'amber',
      title: `${cve(num(totals.cancelledDebtCve))} em dívida de clientes já cancelados`,
      detail: 'Cobrar ou abater: mantido em aberto, distorce a carteira e a taxa de cobrança.'
    });
  }

  return {
    active: activeClients,
    suspended: num(totals.suspended),
    cancelled: num(totals.cancelled),
    activeServices: num(totals.activeServices),
    mrrCve: num(mrr.mrrCve),
    arpuCve: num(totals.activeServices) > 0 ? num(mrr.mrrActiveCve) / num(totals.activeServices) : 0,
    newClients: num(totals.newClients),
    newClientsPrevious: num(totals.newClientsPrevious),
    activations: num(totals.activations),
    cancellations: num(totals.cancellations),
    workOrdersCreated: num(totals.workOrdersCreated),
    workOrdersCompleted: num(totals.workOrdersCompleted),
    openWorkOrders: num(totals.openWorkOrders),
    serviceEvents: num(totals.serviceEvents),
    zones,
    belowPlanPrice: { services: num(uplift.services), upliftCve: num(uplift.upliftCve) },
    cancelledDebtCve: num(totals.cancelledDebtCve),
    findings
  };
}

// ---------------------------------------------------------------- parque

function loadFleet(db: Database.Database): OperationsFleet {
  // `INSTALLED_UNITS_SQL` é a definição única de "em campo" — inclui o backbone,
  // que desde a migração 0050 também consome stock. Contar só as atribuições
  // fazia o stock descer sem o "em campo" subir, e o achado da reserva mentia.
  const rows = db.prepare(`
    SELECT
      ec.id AS catalogId,
      ec.brand, ec.model, ec.type, ec.category, ec.unit_of_measure AS unitOfMeasure,
      ec.stock_total AS stock,
      (SELECT COUNT(*) FROM (${INSTALLED_UNITS_SQL}) u
        WHERE u.catalogId = ec.id AND u.origin = 'cliente') AS deployedClient,
      (SELECT COUNT(*) FROM (${INSTALLED_UNITS_SQL}) u
        WHERE u.catalogId = ec.id AND u.origin = 'backbone') AS deployedBackbone
    FROM equipment_catalog ec
    WHERE ec.active = 1
    ORDER BY deployedClient + deployedBackbone DESC, ec.model COLLATE NOCASE
  `).all() as Array<{
    catalogId: number; brand: string | null; model: string; type: string;
    category: 'equipamento' | 'material'; unitOfMeasure: string; stock: number;
    deployedClient: number; deployedBackbone: number;
  }>;

  const models: OperationsFleetModel[] = rows.map((row) => {
    const stock = num(row.stock);
    const deployedClient = num(row.deployedClient);
    const deployedBackbone = num(row.deployedBackbone);
    const deployed = deployedClient + deployedBackbone;
    // Só é grave não ter reserva daquilo que já está no terreno: é esse o
    // modelo que vai avariar. Um catálogo sem instalações a zero é inócuo.
    const severity: OperationsSeverity =
      stock < 0 ? 'red'
        : deployed > 0 && stock === 0 ? 'red'
          : deployed > 0 && stock === 1 ? 'amber'
            : 'green';
    return {
      catalogId: row.catalogId,
      label: [row.brand, row.model].filter(Boolean).join(' '),
      type: row.type,
      category: row.category,
      unitOfMeasure: row.unitOfMeasure,
      deployed,
      deployedClient,
      deployedBackbone,
      stock,
      severity
    };
  });

  const findings: OperationsFinding[] = [];
  const negative = models.filter((model) => model.stock < 0);
  if (negative.length > 0) {
    findings.push({
      code: 'fleet.negative-stock',
      severity: 'red',
      title: `${negative.length} modelo(s) com stock negativo`,
      detail: `${negative.map((model) => model.label).join(', ')}. Saídas registadas sem a entrada correspondente — o inventário deixou de bater.`
    });
  }
  const noSpare = models.filter((model) => model.stock === 0 && model.deployed > 0);
  if (noSpare.length > 0) {
    // Dizer onde estão as unidades muda a urgência: um modelo só no backbone que
    // avaria leva a zona inteira, não um cliente.
    const where = (model: OperationsFleetModel) => model.deployedBackbone > 0
      ? `${model.label} (${model.deployed} em campo, ${model.deployedBackbone} no backbone)`
      : `${model.label} (${model.deployed} em campo)`;
    findings.push({
      code: 'fleet.no-spare',
      severity: 'red',
      title: `${noSpare.length} modelo(s) em campo sem reserva`,
      detail: `${noSpare.map(where).join(', ')}. Uma avaria deixa o serviço em baixo até haver reposição.`
    });
  }

  // Equipamento do ISP que está na rua sem quem o pague: fechado como "não
  // devolvido", ou ainda aberto num cliente que já se foi embora. Desde o
  // aluguer (0043) cada uma destas unidades também tem uma renda a correr.
  const outstanding = db.prepare(`
    SELECT
      COUNT(*) AS units,
      COALESCE(SUM(${landedCostSql('ec')}), 0) AS valueCve,
      COALESCE(SUM(a.rental_fee_cve), 0) AS monthlyRentalCve
    FROM service_device_assignments a
    JOIN equipment_catalog ec ON ec.id = a.catalog_id
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    WHERE a.ownership = 'isp'
      AND (
        a.return_condition = 'nao_devolvido'
        OR (a.end_date IS NULL AND c.status = 'cancelled')
      )
  `).get() as { units: number; valueCve: number; monthlyRentalCve: number };

  if (num(outstanding.units) > 0) {
    findings.push({
      code: 'fleet.not-returned',
      severity: 'amber',
      title: `${num(outstanding.units)} equipamento(s) do ISP por recolher`,
      detail: `${cve(num(outstanding.valueCve))} em equipamento na rua, em clientes que saíram ou que o deram por não devolvido.`
        + (num(outstanding.monthlyRentalCve) > 0
          ? ` A renda de ${cve(num(outstanding.monthlyRentalCve))}/mês continua a ser emitida sobre eles.`
          : '')
    });
  }

  return {
    models,
    deployedTotal: models.reduce((sum, model) => sum + model.deployed, 0),
    outstanding: {
      units: num(outstanding.units),
      valueCve: num(outstanding.valueCve),
      monthlyRentalCve: num(outstanding.monthlyRentalCve)
    },
    findings
  };
}

// ------------------------------------------------------------ acesso/QoS

/** Passada esta idade, uma reconciliação deixou de descrever o router de agora. */
const RECONCILE_STALE_HOURS = 24;

function loadAccessLayer(
  db: Database.Database,
  network: OperationsNetwork,
  settings: Settings,
  now: Date,
  from: string
): OperationsAccessLayer {
  const sharedUplinkServices = network.devices.reduce((sum, device) => sum + device.serviceCount, 0);

  // O router é a realidade; `service_network_state` é o que a última passagem
  // lá encontrou. Contar daqui é a diferença entre medir e declarar.
  // Limitado = o secret está no perfil PPP do plano: é no perfil que o RouterOS
  // guarda a velocidade. Um secret no perfil por omissão não tem limite nenhum.
  const state = db.prepare(`
    SELECT
      COUNT(CASE WHEN NULLIF(TRIM(COALESCE(n.secret_id, '')), '') IS NOT NULL THEN 1 END) AS provisioned,
      COUNT(CASE WHEN n.profile IS NOT NULL AND n.profile = TRIM(p.router_profile) THEN 1 END) AS rateLimited,
      COUNT(CASE WHEN n.online = 1 THEN 1 END) AS online,
      COUNT(CASE WHEN NULLIF(TRIM(COALESCE(n.divergence, '')), '') IS NOT NULL THEN 1 END) AS divergent,
      MAX(n.checked_at) AS lastCheckedAt
    FROM service_network_state n
    LEFT JOIN services s ON s.id = n.service_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
  `).get() as {
    provisioned: number; rateLimited: number; online: number;
    divergent: number; lastCheckedAt: string | null;
  };

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM whatsapp_notices
        WHERE notice_type = 'suspension' AND date(sent_at) >= @from) AS suspensionNoticesSent,
      -- O corte automático deixa rasto no serviço (migração 0040). É a prova de
      -- que o aviso passou a ter consequência, e conta-se, não se declara.
      (SELECT COUNT(*) FROM service_events
        WHERE event_type = 'corte_rede' AND date(created_at) >= @from) AS automaticSuspensions
  `).get({ from }) as { suspensionNoticesSent: number; automaticSuspensions: number };

  const routerEnabled = settings.routerosEnabled === 'true';
  // O ensaio é o estado por omissão: quem nunca gravou definições não corta nada.
  const routerDryRun = settings.routerosDryRun !== 'false';
  const provisionedServices = num(state.provisioned);
  const rateLimitedServices = num(state.rateLimited);
  const divergentServices = num(state.divergent);
  const lastCheckedAt = state.lastCheckedAt ?? null;
  const reconcileAgeHours = lastCheckedAt !== null
    ? (now.getTime() - (parseDate(lastCheckedAt)?.getTime() ?? now.getTime())) / 3_600_000
    : null;

  const findings: OperationsFinding[] = [];

  if (!routerEnabled) {
    if (network.rootDevices.length > 0 && sharedUplinkServices > 1) {
      findings.push({
        code: 'access.no-qos',
        severity: sharedUplinkServices >= 10 ? 'red' : 'amber',
        title: 'Sem QoS num uplink partilhado',
        detail: `${sharedUplinkServices} serviços partilham o mesmo tubo e a integração de router está desligada. Um cliente pode degradar os restantes sem que isso apareça em lado nenhum.`
      });
    }
    if (num(counts.suspensionNoticesSent) > 0) {
      findings.push({
        code: 'access.notice-without-teeth',
        severity: 'amber',
        title: `${num(counts.suspensionNoticesSent)} aviso(s) de suspensão sem corte automático`,
        detail: 'O sistema avisa que pode suspender, mas com a integração de router desligada nada corta: a suspensão continua a ser feita à mão.'
      });
    }
  } else {
    // Com o router ligado, o que falta deixa de ser a integração e passa a ser o
    // que ela ainda não alcança: serviços sem limite, ou sem secret nenhum.
    const unlimited = provisionedServices - rateLimitedServices;
    if (unlimited > 0) {
      findings.push({
        code: 'access.no-qos',
        severity: unlimited >= 10 ? 'red' : 'amber',
        title: `${unlimited} serviço(s) sem limite de débito`,
        detail: `${rateLimitedServices} de ${provisionedServices} serviços aprovisionados estão no perfil PPP do plano. Um plano sem perfil definido fica sem limite no router — e um cliente sem limite degrada os do mesmo tubo.`
      });
    }
    if (routerDryRun) {
      findings.push({
        code: 'access.dry-run',
        severity: 'amber',
        title: 'Integração de router em modo de ensaio',
        detail: 'A reconciliação planeia as ações e não as escreve. Enquanto o ensaio durar, nenhum corte ou reposição chega ao router.'
      });
    }
    if (divergentServices > 0) {
      findings.push({
        code: 'access.divergence',
        severity: 'amber',
        title: `${divergentServices} serviço(s) em divergência com o router`,
        detail: 'O que está no router não bate com a intenção guardada na base — alguém mexeu por fora, ou uma escrita falhou. É a única classe de erro que o corte automático produz em silêncio.'
      });
    }
    if (reconcileAgeHours === null) {
      findings.push({
        code: 'access.never-reconciled',
        severity: 'amber',
        title: 'Router ligado, reconciliação por correr',
        detail: 'A integração está ligada mas nenhuma passagem terminou. Até lá, o estado da rede é uma intenção por confirmar.'
      });
    } else if (reconcileAgeHours > RECONCILE_STALE_HOURS) {
      findings.push({
        code: 'access.never-reconciled',
        severity: 'amber',
        title: `Última reconciliação há ${Math.round(reconcileAgeHours)} h`,
        detail: 'A leitura do router já não descreve o presente. Verificar a ligação e as credenciais.'
      });
    }
  }

  return {
    routerEnabled,
    routerDryRun,
    pppoeTracked: provisionedServices > 0,
    qosTracked: rateLimitedServices > 0,
    // O único campo que continua constante, porque continua verdade: ninguém
    // guarda sessões. Quando passar a guardar, deixa de ser literal como estes.
    sessionHistoryTracked: false,
    provisionedServices,
    rateLimitedServices,
    onlineServices: num(state.online),
    divergentServices,
    lastCheckedAt,
    sharedUplinkServices,
    automaticSuspensions: num(counts.automaticSuspensions),
    suspensionNoticesSent: num(counts.suspensionNoticesSent),
    findings
  };
}

// -------------------------------------------------------------- cobrança

function nextBillingDate(now: Date, billingDay: number): Date {
  const day = Math.min(Math.max(billingDay, 1), 28 + 3);
  const candidate = new Date(now.getFullYear(), now.getMonth(), day);
  if (candidate >= now) return candidate;
  return new Date(now.getFullYear(), now.getMonth() + 1, day);
}

function loadBilling(
  db: Database.Database,
  settings: Settings,
  now: Date,
  from: string,
  previousFrom: string
): OperationsBilling {
  // Recebido e por receber deixaram de ser a mesma coluna: com parciais, a
  // mesma fatura tem dinheiro de um lado e divida do outro. O que se cobra e
  // sempre o SALDO — dizer 50.000 a quem ja entregou 40.000 e mandar cobrar
  // mal.
  const wallet = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status <> 'cancelled'
        THEN amount_cve - ${balanceSqlExpr('payments')} END), 0) AS paidCve,
      COALESCE(SUM(CASE WHEN ${overdueSqlPredicate()} THEN ${balanceSqlExpr('payments')} END), 0) AS overdueCve,
      COUNT(CASE WHEN ${overdueSqlPredicate()} THEN 1 END) AS overdueCount,
      COALESCE(SUM(CASE WHEN status = 'pending' AND date(due_date) >= date('now') THEN ${balanceSqlExpr('payments')} END), 0) AS pendingNotDueCve,
      COUNT(CASE WHEN status = 'pending' AND date(due_date) >= date('now') THEN 1 END) AS pendingNotDueCount,
      COALESCE(SUM(CASE WHEN status = 'cancelled' THEN amount_cve END), 0) AS cancelledCve
    FROM payments
  `).get() as Record<string, number>;

  // Um recibo por entrada de dinheiro: e a granularidade certa para "recebido
  // esta semana". Só dinheiro novo (source = cash) — abater conta corrente
  // liquida a fatura mas nao faz entrar um tostao.
  const received = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN date(payment_date) >= @from THEN amount_cve END), 0) AS weekCve,
      COUNT(CASE WHEN date(payment_date) >= @from THEN 1 END) AS weekCount,
      COALESCE(SUM(CASE WHEN date(payment_date) >= @previousFrom AND date(payment_date) < @from THEN amount_cve END), 0) AS previousCve,
      COUNT(CASE WHEN date(payment_date) >= @previousFrom AND date(payment_date) < @from THEN 1 END) AS previousCount
    FROM payment_receipts
    WHERE source = 'cash' AND voided_at IS NULL
  `).get({ from, previousFrom }) as Record<string, number>;

  // "Registado hoje" mede o trabalho de hoje, não a data-valor do pagamento:
  // lançar hoje dez recibos de julho é trabalho de hoje. Passou a contar os
  // recibos em vez das entradas de auditoria — o recibo É o gesto, tem o valor
  // certo (o parcial, não o total da fatura) e não se perde se a auditoria
  // falhar, que ela engole erros de propósito para não derrubar a operação.
  const registeredToday = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_cve), 0) AS amountCve
    FROM payment_receipts
    WHERE voided_at IS NULL AND date(created_at) = date('now')
  `).get() as { count: number; amountCve: number };

  const debtors = db.prepare(`
    SELECT
      c.id AS clientId, c.full_name AS clientName, c.phone, c.zone,
      COUNT(p.id) AS payments,
      COALESCE(SUM(${balanceSqlExpr('p')}), 0) AS amountCve,
      CAST(MAX(julianday('now') - julianday(p.due_date)) AS INTEGER) AS maxDaysOverdue,
      CASE WHEN c.status = 'cancelled' THEN 1 ELSE 0 END AS clientCancelled
    FROM payments p
    JOIN clients c ON c.id = p.client_id
    WHERE ${overdueSqlPredicate('p')}
    GROUP BY c.id
    ORDER BY amountCve DESC, maxDaysOverdue DESC
  `).all() as Array<Omit<OperationsDebtor, 'clientCancelled'> & { clientCancelled: number }>;

  const collection = db.prepare(`
    SELECT reference_month AS referenceMonth,
           COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount_cve END), 0) AS issuedCve,
           COALESCE(SUM(CASE WHEN status <> 'cancelled'
             THEN amount_cve - ${balanceSqlExpr('payments')} END), 0) AS collectedCve
    FROM payments
    WHERE reference_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    GROUP BY reference_month
    ORDER BY reference_month DESC
    LIMIT 6
  `).all() as Array<{ referenceMonth: string; issuedCve: number; collectedCve: number }>;
  const cycles: OperationsCollectionCycle[] = collection
    .map((row) => ({
      referenceMonth: row.referenceMonth,
      issuedCve: num(row.issuedCve),
      collectedCve: num(row.collectedCve),
      rate: num(row.issuedCve) > 0 ? num(row.collectedCve) / num(row.issuedCve) : null
    }))
    .reverse();

  const autoBillingDay = Number(settings.autoBillingDay) || DEFAULT_POSTPAID_BILLING_DAY;
  const billingDate = nextBillingDate(now, autoBillingDay);
  const collisionWindow = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_cve), 0) AS amountCve
    FROM payments
    WHERE status = 'pending'
      AND date(due_date) >= date('now')
      AND date(due_date) <= date(@billingDate)
  `).get({ billingDate: isoDate(billingDate) }) as { count: number; amountCve: number };

  const documents = db.prepare(`
    SELECT
      COUNT(CASE WHEN invoice_number IS NOT NULL THEN 1 END) AS invoices,
      COUNT(CASE WHEN receipt_number IS NOT NULL THEN 1 END) AS receipts,
      COUNT(CASE WHEN status = 'paid' AND (receipt_number IS NULL OR receipt_number = '') THEN 1 END) AS paidWithoutReceipt
    FROM payments
  `).get() as OperationsBilling['documents'];

  const methods = db.prepare(`
    SELECT COALESCE(payment_method, 'nao indicado') AS method, COUNT(*) AS count, COALESCE(SUM(amount_cve), 0) AS amountCve
    FROM payments WHERE status = 'paid'
    GROUP BY 1 ORDER BY amountCve DESC
  `).all() as OperationsBilling['methods'];

  const findings: OperationsFinding[] = [];

  const critical = debtors.filter((row) => num(row.maxDaysOverdue) >= OVERDUE_CRITICAL_DAYS);
  if (critical.length > 0) {
    const total = critical.reduce((sum, row) => sum + num(row.amountCve), 0);
    findings.push({
      code: 'billing.critical-overdue',
      severity: 'red',
      title: `${critical.length} devedor(es) acima de ${OVERDUE_CRITICAL_DAYS} dias`,
      detail: `${cve(total)} parados há mais de um mês. O mais antigo: ${critical[0].clientName}, ${num(critical[0].maxDaysOverdue)} dias.`
    });
  }

  const latest = cycles.at(-1);
  const previous = cycles.at(-2);
  if (latest?.rate !== null && latest !== undefined && latest.rate !== null && latest.rate < COLLECTION_WARN) {
    findings.push({
      code: 'billing.collection-rate',
      severity: latest.rate < COLLECTION_CRITICAL ? 'red' : 'amber',
      title: `Cobrança de ${latest.referenceMonth} em ${pct(latest.rate)}`,
      detail: previous?.rate != null
        ? `Vinha de ${pct(previous.rate)} no ciclo anterior. ${cve(latest.issuedCve - latest.collectedCve)} por receber.`
        : `${cve(latest.issuedCve - latest.collectedCve)} por receber neste ciclo.`
    });
  }

  if (num(collisionWindow.count) > 0 && num(collisionWindow.amountCve) > 0) {
    findings.push({
      code: 'billing.calendar-collision',
      severity: 'amber',
      title: `${num(collisionWindow.count)} fatura(s) vencem antes do próximo ciclo`,
      detail: `${cve(num(collisionWindow.amountCve))} vencem até ${isoDate(billingDate)}, o dia em que a faturação automática emite o ciclo seguinte. Dois ciclos na mesma janela.`
    });
  }

  if (num(documents.paidWithoutReceipt) > 0) {
    findings.push({
      code: 'billing.missing-receipts',
      severity: 'amber',
      title: `${num(documents.paidWithoutReceipt)} pagamento(s) sem recibo emitido`,
      detail: 'Recebido sem documento é uma lacuna fiscal e deixa o cliente sem prova.'
    });
  }

  return {
    wallet: {
      paidCve: num(wallet.paidCve),
      overdueCve: num(wallet.overdueCve),
      overdueCount: num(wallet.overdueCount),
      pendingNotDueCve: num(wallet.pendingNotDueCve),
      pendingNotDueCount: num(wallet.pendingNotDueCount),
      cancelledCve: num(wallet.cancelledCve)
    },
    receivedThisWeekCve: num(received.weekCve),
    receivedThisWeekCount: num(received.weekCount),
    receivedPreviousWeekCve: num(received.previousCve),
    receivedPreviousWeekCount: num(received.previousCount),
    registeredTodayCve: num(registeredToday.amountCve),
    registeredTodayCount: num(registeredToday.count),
    debtors: debtors.map((row) => ({
      clientId: row.clientId,
      clientName: row.clientName,
      phone: row.phone,
      zone: row.zone,
      payments: num(row.payments),
      amountCve: num(row.amountCve),
      maxDaysOverdue: num(row.maxDaysOverdue),
      clientCancelled: row.clientCancelled === 1
    })),
    collection: cycles,
    calendarCollision: num(collisionWindow.count) > 0
      ? {
          autoBillingDay,
          nextBillingDate: isoDate(billingDate),
          dueBeforeBillingCve: num(collisionWindow.amountCve),
          dueBeforeBillingCount: num(collisionWindow.count)
        }
      : null,
    documents,
    methods,
    findings
  };
}

// ------------------------------------------------------------- mensagens

function providerBlocked(error: string | null): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return PROVIDER_BLOCK_PATTERNS.some((pattern) => lower.includes(pattern));
}

function loadMessaging(db: Database.Database, settings: Settings, from: string): OperationsMessaging {
  const whatsapp = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN status IN ('sent','delivered','read') AND date(created_at) >= @from THEN 1 END) AS sentThisWeek
    FROM whatsapp_outbox
  `).get({ from }) as Record<string, number>;

  const lastFailure = db.prepare(`
    SELECT last_error AS lastError, updated_at AS updatedAt
    FROM whatsapp_outbox
    WHERE status IN ('pending','failed') AND NULLIF(TRIM(COALESCE(last_error, '')), '') IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() as { lastError: string; updatedAt: string } | undefined;

  const sms = db.prepare(`
    SELECT
      COUNT(CASE WHEN status IN ('pending_dispatch','pending_approval','approved') THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN status = 'sent' AND date(created_at) >= @from THEN 1 END) AS sentThisWeek
    FROM sms_outbox
  `).get({ from }) as Record<string, number>;

  const pairing = db.prepare(`
    SELECT paired_at AS pairedAt, revoked_at AS revokedAt FROM sms_companion_pairing WHERE id = 1
  `).get() as { pairedAt: string | null; revokedAt: string | null } | undefined;

  const blocked = providerBlocked(lastFailure?.lastError ?? null);
  const smsEnabled = settings.smsCompanionEnabled === 'true';
  const smsPaired = Boolean(pairing?.pairedAt && !pairing.revokedAt);

  const findings: OperationsFinding[] = [];
  if (blocked) {
    findings.push({
      code: 'messaging.provider-blocked',
      severity: 'red',
      title: 'Canal WhatsApp recusado pelo provedor',
      detail: `${num(whatsapp.failed)} falhadas e ${num(whatsapp.pending)} em fila. O provedor respondeu: "${(lastFailure?.lastError ?? '').slice(0, 180)}". Enquanto isto durar, nenhum aviso de cobrança chega ao cliente.`
    });
  } else if (num(whatsapp.failed) > 0) {
    findings.push({
      code: 'messaging.failures',
      severity: 'amber',
      title: `${num(whatsapp.failed)} mensagem(ns) WhatsApp falhadas`,
      detail: lastFailure?.lastError
        ? `Último erro: "${lastFailure.lastError.slice(0, 180)}".`
        : 'Sem erro registado — verificar a configuração do provedor.'
    });
  }
  if (blocked && !(smsEnabled && smsPaired)) {
    findings.push({
      code: 'messaging.no-fallback',
      severity: 'red',
      title: 'Sem canal alternativo',
      detail: 'Com o WhatsApp em baixo e o companion SMS desligado ou não emparelhado, não há forma automática de avisar um cliente.'
    });
  }

  return {
    whatsapp: {
      pending: num(whatsapp.pending),
      failed: num(whatsapp.failed),
      sentThisWeek: num(whatsapp.sentThisWeek),
      lastError: lastFailure?.lastError ?? null,
      lastErrorAt: lastFailure?.updatedAt ?? null,
      providerBlocked: blocked
    },
    sms: {
      enabled: smsEnabled,
      paired: smsPaired,
      pending: num(sms.pending),
      failed: num(sms.failed),
      sentThisWeek: num(sms.sentThisWeek)
    },
    findings
  };
}

// --------------------------------------------------------------- sistema

function loadSystem(db: Database.Database, now: Date): OperationsSystem {
  const jobs = jobHealth(db).map((row) => ({
    job: row.job,
    status: row.status,
    ranAt: row.ranAt,
    errors: row.errors
  }));

  let lastBackupAt: string | null = null;
  try {
    lastBackupAt = listBackups()[0]?.createdAt.toISOString() ?? null;
  } catch {
    // Disponibilidade > diagnóstico: uma pasta de backups ilegível não pode
    // derrubar o painel inteiro. Fica null e o finding assinala.
    lastBackupAt = null;
  }
  const backupAgeHours = lastBackupAt
    ? (now.getTime() - new Date(lastBackupAt).getTime()) / 3_600_000
    : null;

  const users = db.prepare(`
    SELECT COUNT(*) AS activeUsers, COUNT(DISTINCT lower(trim(full_name))) AS distinctPeople
    FROM users WHERE active = 1
  `).get() as { activeUsers: number; distinctPeople: number };

  const findings: OperationsFinding[] = [];
  if (backupAgeHours === null) {
    findings.push({
      code: 'system.no-backup',
      severity: 'red',
      title: 'Sem backup legível',
      detail: 'Não foi encontrada nenhuma cópia de segurança. Toda a operação vive numa base local.'
    });
  } else if (backupAgeHours > BACKUP_STALE_HOURS) {
    findings.push({
      code: 'system.stale-backup',
      severity: 'amber',
      title: `Último backup há ${Math.round(backupAgeHours)} h`,
      detail: 'A cópia mais recente já não reflete o trabalho feito desde então.'
    });
  }
  const failing = jobs.filter((job) => job.status === 'error');
  if (failing.length > 0) {
    findings.push({
      code: 'system.job-errors',
      severity: 'red',
      title: `${failing.length} automatismo(s) em erro`,
      detail: failing.map((job) => job.job).join(', ')
    });
  }
  if (num(users.distinctPeople) <= 1) {
    findings.push({
      code: 'system.bus-factor',
      severity: 'amber',
      title: 'Uma só pessoa opera o sistema',
      detail: `${num(users.activeUsers)} conta(s) ativa(s), mas apenas ${num(users.distinctPeople)} pessoa distinta. Sem essa pessoa, a operação para.`
    });
  }

  return {
    jobs,
    lastBackupAt,
    backupAgeHours,
    activeUsers: num(users.activeUsers),
    distinctPeople: num(users.distinctPeople),
    findings
  };
}

// ----------------------------------------------------------- conformidade

function loadCompliance(db: Database.Database, settings: Settings): OperationsCompliance {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS clientsTotal,
      COUNT(CASE WHEN NULLIF(TRIM(COALESCE(nif, '')), '') IS NOT NULL THEN 1 END) AS clientsWithNif,
      COUNT(CASE WHEN NULLIF(TRIM(COALESCE(phone, '')), '') IS NOT NULL THEN 1 END) AS clientsWithPhone
    FROM clients WHERE status <> 'cancelled'
  `).get() as Record<string, number>;

  const companyNifPresent = Boolean((settings.nif ?? '').trim());
  const findings: OperationsFinding[] = [];

  if (!companyNifPresent) {
    findings.push({
      code: 'compliance.no-company-nif',
      severity: 'amber',
      title: 'NIF da empresa por preencher',
      detail: 'Sem NIF emitente não há caminho para e-Fatura/DNRE nem para gerar SAF-T CV.'
    });
  }
  const withoutNif = num(counts.clientsTotal) - num(counts.clientsWithNif);
  if (withoutNif > 0) {
    findings.push({
      code: 'compliance.clients-without-nif',
      severity: num(counts.clientsWithNif) === 0 ? 'amber' : 'green',
      title: `${withoutNif} cliente(s) sem NIF`,
      detail: 'Cada cobrança presencial é uma oportunidade de recolher o NIF em falta.'
    });
  }
  const withoutPhone = num(counts.clientsTotal) - num(counts.clientsWithPhone);
  if (withoutPhone > 0) {
    findings.push({
      code: 'compliance.clients-without-phone',
      severity: 'amber',
      title: `${withoutPhone} cliente(s) sem telefone`,
      detail: 'Ficam fora de qualquer aviso automático de cobrança.'
    });
  }

  return {
    fiscalRegime: settings.fiscalRegime || 'nao definido',
    ivaRate: Number(settings.ivaRate) || 0,
    companyNifPresent,
    clientsTotal: num(counts.clientsTotal),
    clientsWithNif: num(counts.clientsWithNif),
    clientsWithPhone: num(counts.clientsWithPhone),
    findings
  };
}

// ------------------------------------------------------- riscos e ações

/**
 * Riscos e ações derivam dos achados das secções. Um achado descreve o que se
 * observou; o risco quantifica a exposição e a ação diz o que fazer a seguir.
 * Nada aqui é escrito à mão: resolvido o problema, a linha desaparece.
 */
function deriveRisks(status: Omit<OperationsStatus, 'risks' | 'actions' | 'severity' | 'headline'>): OperationsRisk[] {
  const risks: OperationsRisk[] = [];
  const { network, billing, messaging, fleet, accessLayer, customers, system, compliance } = status;

  if (messaging.whatsapp.providerBlocked) {
    risks.push({
      code: 'R-CANAL',
      title: 'Cobrança sem canal de aviso',
      detail: `${messaging.whatsapp.failed} falhadas e ${messaging.whatsapp.pending} em fila. Exposição = o que está vencido mais o que vence a seguir.`,
      severity: 'red',
      exposureCve: billing.wallet.overdueCve + billing.wallet.pendingNotDueCve
    });
  }

  for (const root of network.rootDevices) {
    if (root.mrrShare >= 0.9 && root.clientCount > 0) {
      risks.push({
        code: 'R-UPLINK',
        title: `Uplink único (${root.name})`,
        detail: `Sem alternativa definida, uma falha aqui derruba ${root.clientCount} clientes de uma vez.`,
        severity: 'red',
        exposureCve: root.mrrCve
      });
    }
  }

  const hotspot = network.devices.find((device) => device.upstreamNames.length > 0 && device.mrrShare >= 0.5);
  if (hotspot) {
    risks.push({
      code: 'R-CONCENTRACAO',
      title: `Concentração em ${hotspot.name}`,
      detail: `${hotspot.clientCount} clientes e ${pct(hotspot.mrrShare)} do MRR num só equipamento.`,
      severity: 'amber',
      exposureCve: hotspot.mrrCve
    });
  }

  // A exposição do QoS é o nº de serviços que ficam mesmo sem limite, não o
  // tamanho do tubo: com o router a limitar, partilhar deixou de ser risco.
  const unlimitedServices = accessLayer.routerEnabled
    ? accessLayer.provisionedServices - accessLayer.rateLimitedServices
    : accessLayer.sharedUplinkServices;
  if (accessLayer.findings.some((finding) => finding.code === 'access.no-qos')) {
    risks.push({
      code: 'R-QOS',
      title: accessLayer.routerEnabled
        ? `${unlimitedServices} serviço(s) sem limite de débito`
        : 'Sem QoS num uplink partilhado',
      detail: accessLayer.routerEnabled
        ? `Aprovisionados no router, mas sem limite aplicado. Cada um pode degradar os do mesmo tubo.`
        : `${accessLayer.sharedUplinkServices} serviços no mesmo tubo, sem limite por cliente.`,
      severity: unlimitedServices >= 10 ? 'red' : 'amber',
      exposureCve: null
    });
  }

  if (accessLayer.divergentServices > 0) {
    risks.push({
      code: 'R-DIVERGENCIA',
      title: `${accessLayer.divergentServices} serviço(s) divergentes do router`,
      detail: 'A base diz uma coisa e o router faz outra. Um serviço cortado que continua a passar, ou um pago que continua em baixo — ambos passam despercebidos.',
      severity: 'amber',
      exposureCve: null
    });
  }

  const trend = billing.collection.filter((cycle) => cycle.rate !== null);
  if (trend.length >= 3) {
    const [a, b, c] = trend.slice(-3);
    if (a.rate! > b.rate! && b.rate! > c.rate!) {
      risks.push({
        code: 'R-COBRANCA',
        title: 'Cobrança a degradar ciclo após ciclo',
        detail: `${pct(a.rate!)} → ${pct(b.rate!)} → ${pct(c.rate!)}. A tendência é consistente, não é ruído.`,
        severity: 'amber',
        exposureCve: billing.wallet.overdueCve
      });
    }
  }

  const noSpare = fleet.models.filter((model) => model.stock === 0 && model.deployed > 0);
  if (noSpare.length > 0) {
    risks.push({
      code: 'R-STOCK',
      title: `${noSpare.length} modelo(s) em campo sem reserva`,
      detail: `${noSpare.map((model) => model.label).join(', ')}. Uma avaria deixa o cliente em baixo até haver reposição.`,
      severity: 'amber',
      exposureCve: null
    });
  }

  if (system.findings.some((finding) => finding.code === 'system.no-backup' || finding.code === 'system.stale-backup')) {
    risks.push({
      code: 'R-BACKUP',
      title: 'Proteção de dados desatualizada',
      detail: system.lastBackupAt
        ? `Último backup há ${Math.round(system.backupAgeHours ?? 0)} h.`
        : 'Não foi encontrada nenhuma cópia de segurança.',
      severity: system.lastBackupAt ? 'amber' : 'red',
      exposureCve: null
    });
  }

  if (system.distinctPeople <= 1) {
    risks.push({
      code: 'R-PESSOAS',
      title: 'Bus factor = 1',
      detail: 'Uma só pessoa opera o sistema. Sem ela, a operação para.',
      severity: 'amber',
      exposureCve: null
    });
  }

  if (!compliance.companyNifPresent || compliance.clientsWithNif === 0) {
    risks.push({
      code: 'R-FISCAL',
      title: 'Identificação fiscal incompleta',
      detail: `Regime ${compliance.fiscalRegime}, IVA ${compliance.ivaRate}%. NIF da empresa ${compliance.companyNifPresent ? 'preenchido' : 'vazio'}; ${compliance.clientsWithNif} de ${compliance.clientsTotal} clientes com NIF.`,
      severity: 'amber',
      exposureCve: null
    });
  }

  if (customers.cancelledDebtCve > 0) {
    risks.push({
      code: 'R-DIVIDA-MORTA',
      title: 'Dívida de clientes já saídos',
      detail: 'Sem decisão de cobrar ou abater, continua a inflacionar a carteira.',
      severity: 'amber',
      exposureCve: customers.cancelledDebtCve
    });
  }

  return risks;
}

function deriveActions(status: Omit<OperationsStatus, 'risks' | 'actions' | 'severity' | 'headline'>): OperationsAction[] {
  const actions: OperationsAction[] = [];
  const { network, billing, messaging, fleet, accessLayer, customers, system, compliance } = status;

  if (messaging.whatsapp.providerBlocked) {
    actions.push({
      code: 'A-CANAL',
      title: 'Repor o canal WhatsApp',
      detail: `O provedor recusa os envios. Reposta a subscrição, reprocessar as ${messaging.whatsapp.pending} em fila e reenviar as ${messaging.whatsapp.failed} falhadas.`,
      horizon: 'now',
      severity: 'red',
      upsideCve: null
    });
    if (!messaging.sms.enabled || !messaging.sms.paired) {
      actions.push({
        code: 'A-SMS',
        title: 'Ativar o companion SMS como reserva',
        detail: 'Um canal só é fiável quando tem substituto. Com o WhatsApp em baixo, o SMS é o que resta.',
        horizon: 'now',
        severity: 'amber',
        upsideCve: null
      });
    }
  }

  const worstDebtor = billing.debtors.find((debtor) => debtor.maxDaysOverdue >= OVERDUE_CRITICAL_DAYS);
  if (worstDebtor) {
    actions.push({
      code: 'A-COBRAR',
      title: `Contactar ${worstDebtor.clientName}`,
      detail: `${cve(worstDebtor.amountCve)} em ${worstDebtor.payments} título(s), há ${worstDebtor.maxDaysOverdue} dias.${worstDebtor.phone ? ` Telefone ${worstDebtor.phone}.` : ' Sem telefone registado — obter contacto.'}`,
      horizon: 'now',
      severity: 'red',
      upsideCve: worstDebtor.amountCve
    });
  }

  const cancelledDebtor = billing.debtors.find((debtor) => debtor.clientCancelled);
  if (cancelledDebtor) {
    actions.push({
      code: 'A-DIVIDA-MORTA',
      title: `Decidir sobre a dívida de ${cancelledDebtor.clientName}`,
      detail: `Cliente cancelado com ${cve(cancelledDebtor.amountCve)} em aberto. Cobrar ou abater — em suspenso distorce a carteira.`,
      horizon: 'now',
      severity: 'amber',
      upsideCve: cancelledDebtor.amountCve
    });
  }

  if (billing.calendarCollision) {
    actions.push({
      code: 'A-CALENDARIO',
      title: 'Preparar a concentração de vencimentos',
      detail: `${cve(billing.calendarCollision.dueBeforeBillingCve)} em ${billing.calendarCollision.dueBeforeBillingCount} fatura(s) vencem até ${billing.calendarCollision.nextBillingDate}, o dia do próximo ciclo automático. Avisar com antecedência.`,
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (customers.belowPlanPrice.services > 0) {
    actions.push({
      code: 'A-TARIFA',
      title: `Alinhar ${customers.belowPlanPrice.services} serviço(s) com o preço de tabela`,
      detail: 'Contratos antigos abaixo do preço do plano ativo.',
      horizon: 'week',
      severity: 'amber',
      upsideCve: customers.belowPlanPrice.upliftCve
    });
  }

  const noSpare = fleet.models.filter((model) => model.stock === 0 && model.deployed > 0);
  if (noSpare.length > 0) {
    actions.push({
      code: 'A-STOCK',
      title: 'Repor stock de reserva',
      detail: `Sem reserva: ${noSpare.map((model) => `${model.label} (${model.deployed} em campo)`).join(', ')}.`,
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (fleet.outstanding.units > 0) {
    actions.push({
      code: 'A-RECOLHER',
      title: `Recolher ${fleet.outstanding.units} equipamento(s) do ISP`,
      detail: `${cve(fleet.outstanding.valueCve)} em equipamento na rua, em clientes que saíram ou que o deram por não devolvido.`
        + ' Recolhido em bom estado volta ao stock e deixa de precisar de compra nova.',
      horizon: 'week',
      severity: 'amber',
      // O que se recupera é o valor do equipamento — a renda que continua a
      // correr é dívida a cobrar, não ganho, e já conta noutro sítio.
      upsideCve: fleet.outstanding.valueCve
    });
  }

  if (network.servicesWithoutBackbone.length > 0) {
    actions.push({
      code: 'A-TOPOLOGIA',
      title: `Ligar ${network.servicesWithoutBackbone.length} serviço(s) ao mapa`,
      detail: `Sem backbone associado: ${network.servicesWithoutBackbone.map((row) => row.clientName).join(', ')}.`,
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (system.findings.some((finding) => finding.code === 'system.stale-backup' || finding.code === 'system.no-backup')) {
    actions.push({
      code: 'A-BACKUP',
      title: 'Repor a rotina de backup e testar um restauro',
      detail: 'Copiar para fora desta máquina. Um backup que nunca foi restaurado é uma hipótese, não uma garantia.',
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (compliance.clientsWithNif < compliance.clientsTotal || !compliance.companyNifPresent) {
    actions.push({
      code: 'A-NIF',
      title: 'Completar a identificação fiscal',
      detail: `${compliance.clientsTotal - compliance.clientsWithNif} cliente(s) sem NIF${compliance.companyNifPresent ? '' : ' e NIF da empresa por preencher'}. Pré-requisito para e-Fatura/DNRE e SAF-T CV.`,
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  // O corte automático por PPPoE existe desde a v1.11 (ADR 0007). Estas ações
  // deixaram de ser "construir" e passaram a ser "ligar" e "acabar de afinar" —
  // o painel não pode mandar erguer o que já está de pé.
  if (!accessLayer.routerEnabled) {
    actions.push({
      code: 'A-PPPOE',
      title: 'Ligar a integração de router',
      detail: 'A reconciliação PPPoE já existe e está desligada em Definições. Ligada, é ela que corta por dívida e repõe ao pagamento — sem ela, cada suspensão é feita à mão.',
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  } else if (accessLayer.routerDryRun) {
    actions.push({
      code: 'A-PPPOE',
      title: 'Sair do modo de ensaio',
      detail: 'A integração está ligada mas em ensaio: planeia e não escreve. Confirmadas as ações planeadas, desligar o ensaio para o corte ter consequência.',
      horizon: 'week',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (accessLayer.findings.some((finding) => finding.code === 'access.no-qos')) {
    actions.push({
      code: 'A-QOS',
      title: accessLayer.routerEnabled
        ? 'Dar um perfil PPP aos planos que não o têm'
        : 'Implementar QoS por cliente',
      detail: accessLayer.routerEnabled
        ? `${accessLayer.provisionedServices - accessLayer.rateLimitedServices} serviço(s) aprovisionados sem limite. O limite vem do perfil PPP do plano, feito no Winbox: um plano sem perfil definido fica sem limite no router.`
        : `${accessLayer.sharedUplinkServices} serviços partilham o mesmo uplink. Com um só tubo, o shaping deixa de ser melhoria e passa a ser proteção do serviço.`,
      horizon: accessLayer.routerEnabled ? 'week' : 'quarter',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (accessLayer.divergentServices > 0) {
    actions.push({
      code: 'A-DIVERGENCIA',
      title: `Resolver ${accessLayer.divergentServices} divergência(s) com o router`,
      detail: 'O router não bate com a base. Verificar se alguém mexeu por fora e deixar a reconciliação repor — enquanto durar, o estado do serviço no ecrã não é o do terreno.',
      horizon: 'now',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (network.identification.assignmentIdentified < network.identification.assignmentTotal) {
    // Com propostas por aplicar isto deixa de ser um projeto e passa a ser um
    // ecrã: a descoberta já casou o que viu na rede com o que está no registo.
    const pending = network.discoveryProposals;
    actions.push({
      code: 'A-INVENTARIO',
      title: pending > 0
        ? `Aplicar ${pending} proposta(s) da descoberta`
        : 'Identificar o parque instalado',
      detail: pending > 0
        ? `A descoberta já casou o que viu na rede com o registo: ${pending} proposta(s) de MAC, IP ou modelo prontas a aplicar na aba Descoberta.`
          + ` Fecha ${network.identification.assignmentTotal - network.identification.assignmentIdentified} lacuna(s) sem sair da secretária.`
        : `${network.identification.assignmentIdentified} de ${network.identification.assignmentTotal} atribuições ativas têm MAC ou número de série. Sem isso, cada avaria começa do zero e uma unidade que volte não se sabe qual é.`,
      horizon: pending > 0 ? 'week' : 'quarter',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (network.identification.modeTotal > 0
    && network.identification.withoutOperationMode > network.identification.modeTotal / 2) {
    actions.push({
      code: 'A-MODOS',
      title: `Classificar ${network.identification.withoutOperationMode} equipamento(s)`,
      detail: 'O modo de ligação e o modo de operação preenchem-se na ficha do equipamento e nos backbones.'
        + ' É o que permite saber, sem ir ao terreno, quem fala PPPoE e quem faz de ponte.',
      horizon: 'quarter',
      severity: 'amber',
      upsideCve: null
    });
  }

  if (system.distinctPeople <= 1) {
    actions.push({
      code: 'A-PESSOAS',
      title: 'Criar um segundo operador real',
      detail: 'Existem contas separadas, mas uma só pessoa. Formar alguém para cobrir ausências.',
      horizon: 'quarter',
      severity: 'amber',
      upsideCve: null
    });
  }

  return actions;
}

function buildHeadline(
  severity: OperationsSeverity,
  status: Omit<OperationsStatus, 'risks' | 'actions' | 'severity' | 'headline'>,
  risks: OperationsRisk[]
): string {
  if (severity === 'green') {
    return `Operação estável: ${status.customers.active} clientes ativos e ${cve(status.customers.mrrCve)}/mês contratados, sem bloqueios abertos.`;
  }
  const worst = risks.find((risk) => risk.severity === severity);
  const delta = status.billing.receivedThisWeekCve - status.billing.receivedPreviousWeekCve;
  const trend = status.billing.receivedPreviousWeekCve > 0
    ? ` Cobrança da semana: ${cve(status.billing.receivedThisWeekCve)} (${delta >= 0 ? '+' : ''}${Math.round(share(delta, status.billing.receivedPreviousWeekCve) * 100)}% vs semana anterior).`
    : ` Cobrança da semana: ${cve(status.billing.receivedThisWeekCve)}.`;
  return worst ? `${worst.title}. ${worst.detail}${trend}` : `Há pontos a rever.${trend}`;
}

// ------------------------------------------------------------------ topo

export function loadOperationsStatus(
  db: Database.Database = getSqliteDatabase(),
  now: Date = new Date()
): OperationsStatus {
  // Janela fixada uma vez: se cada secção chamasse date('now') por si, uma
  // consulta à meia-noite podia contar dias diferentes na mesma resposta.
  const from = isoDate(new Date(now.getTime() - 7 * 86_400_000));
  const previousFrom = isoDate(new Date(now.getTime() - 14 * 86_400_000));
  const settings = loadSettings(db);

  const network = loadNetwork(db);
  const customers = loadCustomers(db, from, previousFrom);
  const fleet = loadFleet(db);
  const accessLayer = loadAccessLayer(db, network, settings, now, from);
  const billing = loadBilling(db, settings, now, from, previousFrom);
  const messaging = loadMessaging(db, settings, from);
  const system = loadSystem(db, now);
  const compliance = loadCompliance(db, settings);

  const partial = {
    generatedAt: now.toISOString(),
    period: { from, to: isoDate(now), previousFrom },
    network,
    customers,
    fleet,
    accessLayer,
    billing,
    messaging,
    system,
    compliance
  };

  const risks = deriveRisks(partial);
  const actions = deriveActions(partial);
  const severity = worstSeverity([
    ...network.findings.map((finding) => finding.severity),
    ...customers.findings.map((finding) => finding.severity),
    ...fleet.findings.map((finding) => finding.severity),
    ...accessLayer.findings.map((finding) => finding.severity),
    ...billing.findings.map((finding) => finding.severity),
    ...messaging.findings.map((finding) => finding.severity),
    ...system.findings.map((finding) => finding.severity),
    ...compliance.findings.map((finding) => finding.severity)
  ]);

  return {
    ...partial,
    severity,
    headline: buildHeadline(severity, partial, risks),
    risks,
    actions
  };
}

/**
 * Catraca de tempo do pipeline do mapa.
 *
 * O mapa recompoe, filtra e faz layout a cada mudanca de filtro, tudo dentro de
 * um `useMemo` sincrono — ou seja, no thread que desenha. Se este pipeline
 * crescer mal com o numero de nos, a interface deixa de responder e nao ha
 * spinner que o esconda.
 *
 * Isto nao e um teste de "esta rapido": e um alarme para crescimento nao-linear.
 * Os limites sao folgados de proposito (uma maquina de CI lenta nao pode fazer
 * isto falhar); o que importa e a RAZAO entre 80 e 160 nos.
 */
import { describe, expect, test } from 'vitest';
import type {
  TopologyBackboneNode,
  TopologyBackboneBranch,
  TopologyClientDeviceNode,
  TopologyClientNode,
  TopologySnapshot
} from '../../../shared/topology';
import { composeTopologyGraph } from './topology-graph';
import { filterTopologyGraph } from './topology-filters';
import { layoutTopologyGraph } from './topology-layout';

function backbone(id: number): TopologyBackboneNode {
  return {
    id: `backbone:${id}`,
    kind: 'backbone',
    backboneDeviceId: id,
    catalogId: id,
    label: `Backbone ${id}`,
    brand: 'TP-Link',
    model: 'CPE710',
    catalogType: 'antena',
    serialNumber: `BB-${id}`,
    assetTag: null,
    ipAddress: `10.0.0.${id}`,
    macAddress: null,
    wanMode: 'static',
    operationMode: null,
    island: 'São Vicente',
    zone: 'Monte Verde',
    provisional: false,
    administrativeState: 'active',
    issueCodes: [],
    liveState: null,
    parentIds: ['root:isp'],
    relationship: 'defined_link'
  };
}

function device(assignmentId: number, backboneDeviceId: number): TopologyClientDeviceNode {
  return {
    id: `assignment:${assignmentId}`,
    kind: 'client-device',
    assignmentId,
    catalogId: 1,
    label: `CPE ${assignmentId}`,
    brand: 'TP-Link',
    model: 'CPE510',
    catalogType: 'cpe',
    serialNumber: `SN-${assignmentId}`,
    assetTag: null,
    ipAddress: `192.168.1.${assignmentId % 250}`,
    macAddress: null,
    wanMode: 'static',
    operationMode: assignmentId % 3 === 0 ? 'ap' : null,
    startDate: '2026-07-01',
    administrativeState: 'active',
    issueCodes: [],
    liveState: null,
    parentId: `backbone:${backboneDeviceId}`,
    backboneDeviceId,
    relationship: 'defined_link',
    clients: [{
      id: assignmentId,
      clientCode: `CLI-${assignmentId}`,
      fullName: `Cliente ${assignmentId}`,
      status: 'active',
      island: 'São Vicente',
      zone: 'Monte Verde',
      services: [{
        id: assignmentId,
        status: 'active',
        planId: 1,
        planName: 'Pro',
        assignmentIds: [assignmentId]
      }]
    }]
  };
}

function client(assignmentId: number): TopologyClientNode {
  return {
    id: `client:${assignmentId}@${assignmentId}`,
    kind: 'client',
    clientId: assignmentId,
    serviceId: assignmentId,
    clientCode: `CLI-${assignmentId}`,
    label: `Cliente ${assignmentId}`,
    island: 'São Vicente',
    zone: 'Monte Verde',
    planName: 'Pro',
    serviceStatus: 'active',
    administrativeState: 'active',
    issueCodes: [],
    parentId: `assignment:${assignmentId}`
  };
}

/** Um parque sintetico com `backbones` ramos e `porRamo` equipamentos em cada. */
function parque(backbones: number, porRamo: number) {
  const nodes = Array.from({ length: backbones }, (_, i) => backbone(i + 1));
  const snapshot: TopologySnapshot = {
    generatedAt: '2026-09-11T00:00:00.000Z',
    root: {
      id: 'root:isp',
      kind: 'logical-root',
      label: 'Internet',
      administrativeState: 'active',
      issueCodes: []
    },
    backbones: nodes,
    edges: nodes.map((node) => ({
      id: `core-link:root:isp:${node.id}`,
      kind: 'core-link' as const,
      source: 'root:isp',
      target: node.id,
      relationship: 'defined_link' as const
    })),
    stats: {
      backboneCount: backbones,
      assignmentCount: backbones * porRamo,
      mappedAssignmentCount: backbones * porRamo,
      unmappedAssignmentCount: 0,
      clientCount: backbones * porRamo,
      serviceCount: backbones * porRamo,
      servicesWithoutDeviceCount: 0,
      attentionCount: 0
    }
  };

  const branches = new Map<number, TopologyBackboneBranch>();
  let seq = 0;
  for (let b = 1; b <= backbones; b++) {
    const devices: TopologyClientDeviceNode[] = [];
    const clientNodes: TopologyClientNode[] = [];
    const edges: TopologyBackboneBranch['edges'] = [];
    for (let d = 0; d < porRamo; d++) {
      seq += 1;
      devices.push(device(seq, b));
      clientNodes.push(client(seq));
      edges.push({
        id: `client-link:backbone:${b}:assignment:${seq}`,
        kind: 'client-link',
        source: `backbone:${b}`,
        target: `assignment:${seq}`,
        relationship: 'defined_link'
      });
      edges.push({
        id: `ownership:assignment:${seq}:client:${seq}@${seq}`,
        kind: 'ownership',
        source: `assignment:${seq}`,
        target: `client:${seq}@${seq}`,
        relationship: 'defined_link'
      });
    }
    branches.set(b, {
      generatedAt: snapshot.generatedAt,
      backbone: nodes[b - 1],
      nodes: devices,
      clientNodes,
      edges,
      stats: {
        assignmentCount: porRamo, clientCount: porRamo,
        serviceCount: porRamo, attentionCount: 0
      }
    });
  }

  return {
    snapshot,
    branches,
    expanded: new Set(Array.from({ length: backbones }, (_, i) => i + 1))
  };
}

/** O que o `useMemo` de `TopologyMapView` faz, sincronamente, a cada filtro. */
function pipeline(p: ReturnType<typeof parque>, filters: Parameters<typeof filterTopologyGraph>[1]) {
  const composed = composeTopologyGraph(p.snapshot, p.branches, p.expanded);
  return layoutTopologyGraph(filterTopologyGraph(composed, filters));
}

function mede(fn: () => unknown): number {
  const inicio = performance.now();
  fn();
  return performance.now() - inicio;
}

describe('pipeline do mapa', () => {
  test('o parque real cabe num quadro de interface', () => {
    // 6 ramos x 8 equipamentos = 6 + 48 + 48 + 1 = 103 nos, acima do parque real.
    const p = parque(6, 8);
    const semFiltro = pipeline(p, {});
    expect(semFiltro.nodes.length).toBeGreaterThan(80);

    const ms = mede(() => pipeline(p, { operationMode: 'ap' }));
    // Folgado de proposito: o que se quer apanhar e uma ordem de grandeza, nao
    // a diferenca entre a minha maquina e a de CI.
    expect(ms).toBeLessThan(1000);
  });

  /**
   * A catraca verdadeira. Dobrar os nos nao pode multiplicar o tempo por muito
   * mais do que isso — se multiplicar, ha um O(n^2) escondido e a interface vai
   * deixar de responder no dia em que o parque crescer.
   */
  test('dobrar os nos nao dispara o tempo', () => {
    const pequeno = parque(6, 8);
    const grande = parque(12, 8);

    // Aquecer: a primeira passagem paga compilacao e alocacao.
    pipeline(pequeno, {});
    pipeline(grande, {});

    const tPequeno = Math.max(mede(() => pipeline(pequeno, { operationMode: 'ap' })), 1);
    const tGrande = mede(() => pipeline(grande, { operationMode: 'ap' }));
    const razao = tGrande / tPequeno;
    // Quadratico daria ~4x; damos margem de 8x para ruido de maquina.
    expect(razao).toBeLessThan(8);
  });
});

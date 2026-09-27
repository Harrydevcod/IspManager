/** @vitest-environment jsdom */
import { expect, test } from 'vitest';
import type { TopologyLive } from '../../../shared/topology';
import { composeTopologyGraph } from './topology-graph';
import { backboneOne, backboneTwo, snapshot } from './topologyTestFixtures';
import { decorateEdges } from './TopologyMapView';

test('a fallen interface paints the router branch red and dashed', () => {
  const switchNode = { ...backboneTwo, parentIds: ['backbone:10' as const], routerInterface: 'ether3' };
  const topology = {
    ...snapshot,
    backbones: [backboneOne, switchNode],
    edges: [{ id: 'core-link:backbone:10:backbone:20' as const, kind: 'core-link' as const, source: 'backbone:10' as const, target: 'backbone:20' as const, relationship: 'defined_link' as const }]
  };
  const live: TopologyLive = { available: true, routerDeviceId: 10, interfaces: [{ name: 'ether3', running: false, downBps: null, upBps: null }], seen: [], checks: [] };
  const edges = decorateEdges(composeTopologyGraph(topology, new Map(), new Set()), false, live, topology);
  expect(edges[0].label).toBe('Porta caída');
  expect(edges[0].style).toMatchObject({ stroke: 'var(--danger)', strokeDasharray: '5 4' });
  const unavailable = decorateEdges(composeTopologyGraph(topology, new Map(), new Set()), false, { available: false, reason: 'Desligado', routerDeviceId: 10 }, topology);
  expect(unavailable[0].style).not.toMatchObject({ stroke: 'var(--danger)' });
});

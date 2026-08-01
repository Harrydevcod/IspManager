import type {
  TopologyBackboneBranch,
  TopologyBackboneNode,
  TopologyClientDeviceNode,
  TopologySnapshot
} from '../../../shared/topology';

export const backboneOne: TopologyBackboneNode = {
  id: 'backbone:10',
  kind: 'backbone',
  backboneDeviceId: 10,
  catalogId: 10,
  label: 'Ubiquiti Rocket Prism',
  brand: 'Ubiquiti',
  model: 'Rocket Prism',
  catalogType: 'antena',
  serialNumber: 'BB-010',
  assetTag: 'AT-010',
  ipAddress: '10.20.0.1',
  macAddress: 'AA:BB:CC:DD:EE:10',
  island: 'São Vicente',
  zone: 'Monte Verde',
  provisional: false,
  administrativeState: 'active',
  issueCodes: [],
  parentIds: ['root:isp'],
  relationship: 'defined_link'
};

export const backboneTwo: TopologyBackboneNode = {
  ...backboneOne,
  id: 'backbone:20',
  backboneDeviceId: 20,
  catalogId: 20,
  label: 'MikroTik Legacy',
  brand: 'MikroTik',
  model: 'Legacy',
  serialNumber: null,
  assetTag: null,
  ipAddress: null,
  macAddress: null,
  island: null,
  zone: null,
  provisional: true,
  administrativeState: 'inactive',
  issueCodes: ['inactive', 'provisional_identity']
};

export const snapshot: TopologySnapshot = {
  generatedAt: '2026-07-28T12:00:00.000Z',
  root: {
    id: 'root:isp',
    kind: 'logical-root',
    label: 'Internet',
    administrativeState: 'active',
    issueCodes: []
  },
  backbones: [backboneOne, backboneTwo],
  edges: [
    {
      id: 'core-link:root:isp:backbone:10',
      kind: 'core-link',
      source: 'root:isp',
      target: 'backbone:10',
      relationship: 'defined_link'
    },
    {
      id: 'core-link:root:isp:backbone:20',
      kind: 'core-link',
      source: 'root:isp',
      target: 'backbone:20',
      relationship: 'defined_link'
    }
  ],
  stats: {
    backboneCount: 2,
    assignmentCount: 2,
    mappedAssignmentCount: 2,
    unmappedAssignmentCount: 0,
    clientCount: 2,
    serviceCount: 2,
    attentionCount: 2
  }
};

function clientDevice(
  assignmentId: number,
  backboneDeviceId: number,
  catalogId: number,
  clientId: number,
  island: string,
  zone: string
): TopologyClientDeviceNode {
  return {
    id: `assignment:${assignmentId}`,
    kind: 'client-device',
    assignmentId,
    catalogId,
    label: `CPE ${assignmentId}`,
    brand: 'Ubiquiti',
    model: `CPE ${assignmentId}`,
    catalogType: 'cpe',
    serialNumber: `SN-${assignmentId}`,
    assetTag: null,
    ipAddress: `10.0.0.${assignmentId}`,
    macAddress: `AA:BB:CC:DD:EE:${assignmentId}`,
    startDate: '2026-07-01',
    administrativeState: assignmentId === 200 ? 'inactive' : 'active',
    issueCodes: assignmentId === 200 ? ['inactive'] : [],
    parentId: `backbone:${backboneDeviceId}`,
    relationship: 'defined_link',
    clients: [{
      id: clientId,
      clientCode: `CLI-${clientId}`,
      fullName: `Cliente ${clientId}`,
      status: 'active',
      island,
      zone,
      services: [{
        id: clientId * 10,
        status: 'active',
        planId: 1,
        planName: 'Pro',
        assignmentIds: [assignmentId]
      }]
    }]
  };
}

export const deviceOne = clientDevice(100, 10, 10, 1, 'São Vicente', 'Mindelo');
export const deviceTwo = clientDevice(200, 20, 20, 2, 'Sal', 'Espargos');

export const branchOne: TopologyBackboneBranch = {
  generatedAt: '2026-07-28T12:01:00.000Z',
  backbone: backboneOne,
  nodes: [deviceOne],
  edges: [{
    id: 'client-link:backbone:10:assignment:100',
    kind: 'client-link',
    source: 'backbone:10',
    target: 'assignment:100',
    relationship: 'defined_link'
  }],
  stats: { assignmentCount: 1, clientCount: 1, serviceCount: 1, attentionCount: 0 }
};

export const branchTwo: TopologyBackboneBranch = {
  generatedAt: '2026-07-28T12:02:00.000Z',
  backbone: backboneTwo,
  nodes: [deviceTwo],
  edges: [{
    id: 'client-link:backbone:20:assignment:200',
    kind: 'client-link',
    source: 'backbone:20',
    target: 'assignment:200',
    relationship: 'defined_link'
  }],
  stats: { assignmentCount: 1, clientCount: 1, serviceCount: 1, attentionCount: 1 }
};

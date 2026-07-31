export type BackboneStatus = 'active' | 'maintenance' | 'retired';

export type BackboneDeviceSummary = {
  id: number;
  catalogId: number;
  catalogBrand: string | null;
  catalogModel: string;
  catalogType: string;
  name: string;
  status: BackboneStatus;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  provisional: boolean;
  /** De quem esta unidade recebe sinal. `null` = alimentada pela Internet. */
  upstreamDeviceId: number | null;
  upstreamName: string | null;
  /** Unidades não-retiradas que esta alimenta. */
  downstreamCount: number;
  linkedAssignmentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type BackboneAssignmentSummary = {
  id: number;
  catalogId: number;
  catalogBrand: string | null;
  catalogModel: string;
  catalogType: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  startDate: string;
  clientId: number;
  clientCode: string;
  clientName: string;
  serviceId: number;
  serviceStatus: 'active' | 'suspended' | 'cancelled';
  backboneDeviceId: number | null;
  backboneName: string | null;
  linkedAt: string | null;
};

export type BackboneDeviceDetail = BackboneDeviceSummary & {
  notes: string | null;
  assignments: BackboneAssignmentSummary[];
  downstream: BackboneDeviceSummary[];
};

export type BackbonePage<T> = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: T[];
};

export type BackboneWriteInput = {
  catalogId: number;
  name: string;
  status: BackboneStatus;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  island: string | null;
  zone: string | null;
  notes: string | null;
  upstreamDeviceId: number | null;
  expectedUpdatedAt?: string;
};

export type AssignmentBackboneInput = {
  backboneDeviceId: number;
  reason: string | null;
};

export type BackboneListQuery = {
  query?: string;
  status?: BackboneStatus;
  /** Só as unidades alimentadas por esta. */
  upstreamDeviceId?: number;
  page: number;
  pageSize: number;
};

export type AssignmentListQuery = {
  query?: string;
  mapping: 'all' | 'linked' | 'unlinked';
  backboneDeviceId?: number;
  page: number;
  pageSize: number;
};

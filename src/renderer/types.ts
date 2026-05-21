declare global {
  interface Window {
    ispm?: { platform: string; relaunch?: () => Promise<void> };
  }
}

export type HealthState = 'checking' | 'online' | 'offline';
export type SectionId =
  | 'dashboard'
  | 'clients'
  | 'plans'
  | 'services'
  | 'payments'
  | 'investments'
  | 'work-orders'
  | 'stock'
  | 'reports'
  | 'users'
  | 'audit'
  | 'settings';

export type Client = {
  id: number;
  clientCode: string;
  fullName: string;
  phone: string | null;
  email?: string | null;
  address?: string | null;
  island: string | null;
  zone: string | null;
  status: 'active' | 'suspended' | 'cancelled';
};

export type ServiceRow = {
  id: number;
  clientId: number;
  clientName: string;
  planId: number | null;
  planName: string | null;
  monthlyValueCve: number;
  dueDay: number;
  status: 'active' | 'suspended' | 'cancelled';
  activationDate: string | null;
  technicalNotes: string | null;
};

export type PaymentRow = {
  id: number;
  clientName: string;
  clientCode: string | null;
  clientNif: string | null;
  clientPhone: string | null;
  referenceMonth: string;
  amountCve: number;
  dueDate: string;
  paymentDate: string | null;
  paymentMethod: string | null;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  invoiceNumber: string | null;
  receiptNumber: string | null;
};

export type PlanRow = {
  id: number;
  name: string;
  downloadSpeed: string;
  uploadSpeed: string;
  connectionType: 'radio' | 'fibra' | 'cabo' | 'outro';
  monthlyPriceCve: number;
  installationFeeCve: number;
  description: string | null;
  active: number;
};

export type StockCatalogRow = {
  id: number;
  type: 'cpe' | 'router' | 'antena' | 'switch' | 'outro';
  brand: string | null;
  model: string;
  supplier: string | null;
  purchasePriceCve: number;
  sellingPriceCve: number;
  rentalFeeCve: number;
  stockTotal: number;
  active: number;
  landedCostCve: number;
  lastMovementAt: string | null;
};

export type StockSummary = {
  totals: {
    models: number;
    available: number;
    lowStock: number;
    outOfStock: number;
    inventoryValueCve: number;
  };
  rows: StockCatalogRow[];
};

export type StockMovement = {
  id: number;
  type: 'entrada' | 'saida' | 'devolucao' | 'ajuste';
  quantity: number;
  unitCostCve: number;
  supplier: string | null;
  reference: string | null;
  notes: string | null;
  createdAt: string;
};

export type RevenuePoint = {
  referenceMonth: string;
  paidCve: number;
  pendingCve: number;
  expenseCve: number;
};

export type InvestmentType =
  | 'cliente'
  | 'zona'
  | 'equipamento'
  | 'infraestrutura'
  | 'manutencao'
  | 'expansao'
  | 'outro';

export type InvestmentStatus = 'planeado' | 'em_execucao' | 'ativo' | 'recuperado' | 'cancelado';

export type InvestmentItemType =
  | 'antena'
  | 'router'
  | 'cpe'
  | 'switch'
  | 'cabo'
  | 'conector'
  | 'fibra'
  | 'caixa'
  | 'poste'
  | 'ups'
  | 'bateria'
  | 'ferramenta'
  | 'material'
  | 'instalacao'
  | 'mao_obra'
  | 'manutencao'
  | 'outro';

export type InvestmentItem = {
  id: number;
  investmentId: number;
  itemType: InvestmentItemType;
  itemName: string;
  quantity: number;
  quantityUsed: number;
  quantityRemaining: number;
  unitCostCve: number;
  totalCostCve: number;
};

export type Investment = {
  id: number;
  name: string;
  type: InvestmentType;
  clientId: number | null;
  clientName: string | null;
  zone: string | null;
  description: string | null;
  supplier: string | null;
  investmentDate: string;
  referenceMonth: string;
  status: InvestmentStatus;
  targetClients: number;
  installedClients: number;
  desiredPaybackMonths: number;
  desiredMarginPct: number;
  expectedMonthlyRevenueCve: number;
  monthlyOperationalCostCve: number;
  accumulatedRevenueCve: number;
  totalCostCve: number;
  costPerClientCve: number;
  operationalCostPerClientCve: number;
  recommendedPlanCve: number;
  monthlyNetProfitCve: number;
  accumulatedProfitCve: number;
  recoveryMonths: number | null;
  roiPct: number | null;
  annualRoiPct: number | null;
  isRecovered: boolean;
  notes: string | null;
  items: InvestmentItem[];
  createdAt: string;
  updatedAt: string;
};

export type InvestmentList = {
  rows: Investment[];
  totals: {
    count: number;
    totalCostCve: number;
    monthlyNetProfitCve: number;
    accumulatedProfitCve: number;
    averageRoiPct: number | null;
    lowRoiCount: number;
    notRecoveredCount: number;
  };
  zoneSummary: Array<{
    zone: string;
    investments: number;
    totalCostCve: number;
    monthlyNetProfitCve: number;
    roiPct: number | null;
  }>;
  alerts: string[];
};

export type UpcomingDue = {
  paymentId: number;
  clientName: string;
  clientCode: string;
  dueDate: string;
  amountCve: number;
};

export type CriticalOverdue = {
  paymentId: number;
  clientName: string;
  clientCode: string;
  clientPhone: string | null;
  dueDate: string;
  amountCve: number;
  daysOverdue: number;
};

export type PlanMixEntry = {
  connectionType: string;
  count: number;
};

export type DashboardSummary = {
  totalClients: number;
  activeClients: number;
  suspendedClients: number;
  cancelledClients: number;
  overduePayments: number;
  pendingPayments: number;
  lowStockModels: number;
  activeServices: number;
  openWorkOrders: number;
  paidMonthCve: number;
  revenueByMonth: RevenuePoint[];
  upcomingDues: UpcomingDue[];
  criticalOverdue: CriticalOverdue[];
  planMix: PlanMixEntry[];
  workQueue: string[];
};

export type ReportsSummary = {
  metrics: {
    totalClients: number;
    activeServices: number;
    overduePayments: number;
    overdueAmountCve: number;
    paidAmountCve: number;
    stockValueCve: number;
  };
  revenueByMonth: Array<{
    referenceMonth: string;
    paidCve: number;
    pendingCve: number;
    payments: number;
  }>;
  overdueClients: Array<{
    clientName: string;
    clientCode: string;
    phone: string | null;
    payments: number;
    amountCve: number;
    oldestDueDate: string;
  }>;
  stockRows: Array<{
    type: string;
    brand: string;
    model: string;
    stockTotal: number;
    valueCve: number;
  }>;
};

export type ReportView = 'revenue' | 'overdue' | 'stock';

export type WhatsappMessageData = {
  fullName: string;
  clientCode: string;
  phone: string | null;
};

export type DeviceAssignment = {
  id: number;
  serviceId: number;
  catalogId: number;
  catalogType: string;
  brand: string | null;
  model: string;
  serialNumber: string | null;
  assetTag: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  technicianName: string | null;
  notes: string | null;
  startDate: string;
  endDate: string | null;
  createdAt: string;
};

export type ServiceEventType = 'instalacao' | 'manutencao' | 'troca_equipamento' | 'visita' | 'alteracao_servico';

export type ServiceEvent = {
  id: number;
  serviceId: number;
  eventType: ServiceEventType;
  notes: string | null;
  technicianName: string | null;
  createdAt: string;
};

export type TechnicalHistory = {
  serviceId: number;
  assignments: DeviceAssignment[];
  events: ServiceEvent[];
};

export type CatalogAssignmentRow = {
  id: number;
  serviceId: number;
  clientId: number;
  clientCode: string;
  clientName: string;
  clientPhone: string | null;
  serialNumber: string | null;
  assetTag: string | null;
  macAddress: string | null;
  ipAddress: string | null;
  startDate: string;
  endDate: string | null;
  notes: string | null;
};

export type CatalogAssignments = {
  catalogId: number;
  activeCount: number;
  totalCount: number;
  items: CatalogAssignmentRow[];
};

export type WorkOrderStatus = 'aguarda' | 'agendada' | 'em_curso' | 'concluida' | 'cancelada';
export type WorkOrderPriority = 'baixa' | 'media' | 'alta';

export type WorkOrder = {
  id: number;
  serviceId: number | null;
  clientId: number | null;
  clientName: string | null;
  clientCode: string | null;
  planName: string | null;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  eventType: ServiceEventType | null;
  assignedTo: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completionNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkOrderBoard = {
  columns: Array<{ status: WorkOrderStatus; items: WorkOrder[] }>;
  totals: {
    total: number;
    open: number;
    byStatus: Record<WorkOrderStatus, number>;
  };
};

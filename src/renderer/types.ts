declare global {
  interface Window {
    ispm?: {
      platform: string;
      onShowReleaseNotes?: (callback: (version: string) => void) => () => void;
      relaunch?: () => Promise<void>;
      chooseBackupFile?: () => Promise<string | null>;
      chooseBackupDir?: () => Promise<string | null>;
      openBackupDir?: (dir: string) => Promise<void>;
      openExternal?: (url: string) => Promise<boolean>;
      saveDocument?: (
        filename: string,
        data: Uint8Array
      ) => Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }>;
      printDocument?: (
        data: Uint8Array
      ) => Promise<{ printed: boolean; canceled?: boolean; error?: string }>;
    };
  }
}

export type HealthState = 'checking' | 'online' | 'offline';
export type SectionId =
  | 'dashboard'
  | 'clients'
  | 'plans'
  | 'services'
  | 'topology'
  | 'finance'
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
  nif?: string | null;
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
  audiovisualMode: 'none' | 'monthly' | 'annual';
  audiovisualMonthlyCve: number;
  audiovisualAnnualCve: number;
  /** IPs dos equipamentos ativos, separados por vírgula. Null se não houver nenhum. */
  deviceIps: string | null;
  /** Identidade no MikroTik. Null = serviço fora do controlo de acesso. */
  pppoeUsername: string | null;
  pppoePassword: string | null;
  /** Realidade lida do router (ADR 0007); null enquanto nunca foi lido. */
  routerOnline: number | null;
  routerEnabled: number | null;
  routerDivergence: string | null;
};

export type AudiovisualConfig = {
  enabled: boolean;
  label: string;
  monthlyCve: number;
  annualCve: number;
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
  canRegenerate: number;
};

export type PaymentStatus = PaymentRow['status'];

/** Rótulos pt-PT do estado de pagamento — fonte única para badges/detalhes. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Pendente',
  paid: 'Pago',
  overdue: 'Em atraso',
  cancelled: 'Anulado'
};

export const paymentStatusLabel = (status: PaymentStatus): string => PAYMENT_STATUS_LABELS[status];

export type SmsEventType = 'invoice_issued' | 'receipt_confirmed' | 'payment_overdue' | 'suspension_notice';

export type SmsStatus = {
  configured: boolean;
  paired: boolean;
  reachable: boolean;
  active: boolean;
  baseUrl: string;
  deviceName: string;
};

export type SmsMonthlyReport = {
  month: string;
  timezone: 'Atlantic/Cape_Verde';
  counts: {
    pendingDispatch: number;
    pendingApproval: number;
    sent: number;
    failed: number;
    rejected: number;
  };
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
  /** Débito em Mbps. Null = sem limite definido; o router fica como está. */
  downloadMbps: number | null;
  uploadMbps: number | null;
};

export type StockCatalogRow = {
  id: number;
  category: 'equipamento' | 'material';
  type: 'cpe' | 'router' | 'antena' | 'switch' | 'cabo' | 'conector' | 'ficha' | 'suporte' | 'outro';
  brand: string | null;
  model: string;
  supplier: string | null;
  unitOfMeasure: string;
  isSerialized: number;
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
  opexCve: number;
};

export type ExpenseCategory =
  | 'equipamento'
  | 'infraestrutura'
  | 'salarios'
  | 'marketing'
  | 'impostos'
  | 'licencas'
  | 'combustivel'
  | 'banda_internet'
  | 'aluguer'
  | 'energia'
  | 'manutencao'
  | 'deslocacoes'
  | 'reparacoes'
  | 'outros';

export type ExpenseTemplate = {
  id: number;
  name: string;
  category: ExpenseCategory;
  amountCve: number;
  dayOfMonth: number;
  supplier: string | null;
  notes: string | null;
  investmentId: number | null;
  investmentName: string | null;
  zone: string | null;
  clientId: number | null;
  clientName: string | null;
  active: number;
  lastGeneratedMonth: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseTemplateList = {
  rows: ExpenseTemplate[];
  totals: { count: number; totalActiveMonthlyCve: number };
};

export type Expense = {
  id: number;
  category: ExpenseCategory;
  description: string;
  amountCve: number;
  expenseDate: string;
  referenceMonth: string;
  supplier: string | null;
  invoiceReference: string | null;
  notes: string | null;
  investmentId: number | null;
  investmentName: string | null;
  zone: string | null;
  clientId: number | null;
  clientName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseList = {
  rows: Expense[];
  totals: {
    count: number;
    totalCve: number;
    byCategory: Array<{ category: string; count: number; totalCve: number }>;
    accumulated: {
      totalCve: number;
      count: number;
      opexCve: number;
      capexCve: number;
      opexCount: number;
      capexCount: number;
      byYear: Array<{ year: string; opexCve: number; capexCve: number; totalCve: number }>;
    };
  };
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
  /** Associação exata a vários clientes (tabela investment_clients). */
  clients: Array<{ id: number; name: string }>;
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
  imputedMonthlyOpexCve: number;
  directAllocatedOpexCve: number;
  effectiveMonthlyOpexCve: number;
  actualMonthlyRevenueCve: number | null;
  revenueSource: 'client' | 'zone' | 'global-share' | null;
  revenueVarianceCve: number | null;
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

export type CompanyOpexShare = {
  totalExpensesCve: number;
  totalAllocatedCve: number;
  totalUnallocatedCve: number;
  monthsWithExpenses: number;
  monthsWithUnallocated: number;
  avgMonthlyOpex: number;
  avgMonthlyUnallocated: number;
  totalInstalledActive: number;
  opexPerClientPerMonth: number;
  directByInvestment: Record<number, number>;
  directByZone: Record<string, number>;
  directByClient: Record<number, number>;
};

export type ProfitabilityAlert = {
  severity: 'info' | 'warning' | 'danger';
  message: string;
  target?: { kind: 'investment' | 'zone' | 'global'; id?: number; name: string };
};

export type EquipmentUsage = {
  itemType: string;
  totalCostCve: number;
  quantity: number;
  quantityUsed: number;
};

export type InvestmentTimelinePoint = {
  month: string;
  paidRevenueCve: number;
  imputedOpexCve: number;
  directOpexCve: number;
  monthlyNetCve: number;
  cumulativeNetCve: number;
  cumulativeProfitCve: number;
  roiPct: number | null;
};

export type InvestmentTimeline = {
  investment: { id: number; name: string; totalCostCve: number; desiredPaybackMonths: number; investmentDate: string };
  points: InvestmentTimelinePoint[];
  recoveredAt: string | null;
  monthsToRecovery: number | null;
};

export type InvestmentList = {
  rows: Investment[];
  totals: {
    count: number;
    totalCostCve: number;
    totalExpensesCve: number;
    totalInvestedCve: number;
    backboneStockCve: number;
    ownInfrastructureCve: number;
    totalReceivedCve: number;
    companyAccumulatedProfitCve: number;
    investedByYear: Array<{ year: string; capexCve: number; opexCve: number; totalCve: number }>;
    monthlyNetProfitCve: number;
    accumulatedProfitCve: number;
    totalImputedOpexCve: number;
    totalDirectOpexCve: number;
    totalEffectiveOpexCve: number;
    totalActualRevenueCve: number;
    averageRoiPct: number | null;
    lowRoiCount: number;
    notRecoveredCount: number;
  };
  companyOpexShare: CompanyOpexShare;
  zoneSummary: Array<{
    zone: string;
    investments: number;
    totalCostCve: number;
    monthlyNetProfitCve: number;
    roiPct: number | null;
  }>;
  equipmentTop: EquipmentUsage[];
  alerts: ProfitabilityAlert[];
};

export const EMPTY_INVESTMENT_LIST: InvestmentList = {
  rows: [],
  totals: { count: 0, totalCostCve: 0, totalExpensesCve: 0, totalInvestedCve: 0, backboneStockCve: 0, ownInfrastructureCve: 0, totalReceivedCve: 0, companyAccumulatedProfitCve: 0, investedByYear: [], monthlyNetProfitCve: 0, accumulatedProfitCve: 0, totalImputedOpexCve: 0, totalDirectOpexCve: 0, totalEffectiveOpexCve: 0, totalActualRevenueCve: 0, averageRoiPct: null, lowRoiCount: 0, notRecoveredCount: 0 },
  companyOpexShare: { totalExpensesCve: 0, totalAllocatedCve: 0, totalUnallocatedCve: 0, monthsWithExpenses: 0, monthsWithUnallocated: 0, avgMonthlyOpex: 0, avgMonthlyUnallocated: 0, totalInstalledActive: 0, opexPerClientPerMonth: 0, directByInvestment: {}, directByZone: {}, directByClient: {} },
  zoneSummary: [],
  equipmentTop: [],
  alerts: []
};

export type ClientProfitability = {
  clientId: number;
  client: {
    id: number;
    clientCode: string;
    fullName: string;
    phone: string | null;
    island: string | null;
    zone: string | null;
    status: string;
  };
  installationCostCve: number;
  investments: Array<{
    id: number;
    name: string;
    type: string;
    investmentDate: string;
    referenceMonth: string;
    status: string;
    zone: string | null;
    totalCostCve: number;
  }>;
  equipmentUsed: Array<{
    itemType: string;
    itemName: string;
    quantity: number;
    quantityUsed: number;
    totalCostCve: number;
  }>;
  paidRevenueCve: number;
  pendingRevenueCve: number;
  monthsActive: number;
  paidMonths: number;
  monthlyAverageRevenueCve: number;
  imputedMonthlyOpexCve: number;
  directClientOpexCve: number;
  directZoneOpexCve: number;
  directInvestmentOpexCve: number;
  effectiveMonthlyOpexCve: number;
  cumulativeOpexCve: number;
  monthlyNetProfitCve: number;
  netProfitCve: number;
  monthsToBreakeven: number | null;
  projectedBreakevenDate: string | null;
  profitabilityPct: number | null;
  isRecovered: boolean;
  companyOpexShare: CompanyOpexShare;
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
  paidPrevMonthCve: number;
  pendingMonthCve: number;
  pendingMonthCount: number;
  pendingPreviousCve: number;
  paidTotalCve: number;
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
  pagination: {
    view: ReportView;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type ReportView = 'revenue' | 'overdue' | 'stock';

export type DataQualityIncompleteFlag = 'noPhone' | 'noActiveService' | 'noAddress' | 'noNif';

export type DataQualitySummary = {
  incompleteCounts: {
    noPhone: number;
    noActiveService: number;
    noAddress: number;
    noNif: number;
    total: number;
  };
  incompleteClients: Array<{
    id: number;
    clientCode: string;
    fullName: string;
    status: 'active' | 'suspended' | 'cancelled';
    phone: string | null;
    flags: DataQualityIncompleteFlag[];
  }>;
  duplicateGroups: Array<{
    key: string;
    reason: 'phone' | 'name';
    clients: Array<{ id: number; clientCode: string; fullName: string; phone: string | null }>;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

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
  /** 1 = instalado neste serviço; 0 = partilhado a partir de outro serviço. */
  isOwner: number;
  /** Clientes servidos por partilha, separados por vírgula. */
  sharedWithNames: string | null;
  shareCount: number;
};

export type MaterialLine = {
  id: number;
  catalogId: number;
  catalogType: string;
  brand: string | null;
  model: string;
  unitOfMeasure: string;
  quantity: number;
  unitCostCve: number;
  notes: string | null;
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

export type InstallCost = {
  id: number;
  kind: 'mao_de_obra' | 'transporte' | 'outro';
  description: string | null;
  amountCve: number;
  createdAt: string;
};

export type TechnicalHistory = {
  serviceId: number;
  assignments: DeviceAssignment[];
  materials: MaterialLine[];
  installCosts: InstallCost[];
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
  sharedWithNames: string | null;
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

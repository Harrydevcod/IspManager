/**
 * Estado da operação — contrato partilhado entre backend e renderer.
 *
 * Uma leitura viva do estado do ISP: rede, clientes, parque, cobrança,
 * mensagens e conformidade, mais os riscos e as ações que daí decorrem.
 * Ao contrário do Dashboard (que responde "como estamos hoje?"), este read
 * model responde "o que é que exige decisão agora?" — por isso cada secção
 * termina em achados, não em números soltos.
 *
 * Regra do modelo: riscos e ações são DERIVADOS dos dados, nunca escritos à
 * mão. Uma lista fixa envelhece em silêncio; uma lista derivada desaparece
 * sozinha quando o problema é resolvido.
 */

/** Semáforo global. `red` exige ação hoje, `amber` esta semana. */
export type OperationsSeverity = 'green' | 'amber' | 'red';

/** Uma leitura com valor observado e limiar, para a UI poder mostrar o porquê. */
export type OperationsFinding = {
  code: string;
  severity: OperationsSeverity;
  title: string;
  detail: string;
};

export type OperationsPeriod = {
  /** Início da janela de 7 dias (inclusive), ISO date. */
  from: string;
  /** Fim da janela (exclusive) — normalmente agora. */
  to: string;
  /** Início da janela de comparação (7 dias antes de `from`). */
  previousFrom: string;
};

// ---------------------------------------------------------------- rede

export type OperationsBackboneNode = {
  backboneDeviceId: number;
  name: string;
  equipment: string;
  ipAddress: string | null;
  zone: string | null;
  status: 'active' | 'maintenance';
  /** Nomes dos equipamentos que o alimentam. Vazio = é raiz de uplink. */
  upstreamNames: string[];
  clientCount: number;
  serviceCount: number;
  mrrCve: number;
  /** Quota do MRR total atribuído, 0–1. Acima de `concentrationThreshold` é risco. */
  mrrShare: number;
  /** Última leitura da sonda. `null` = sem IP, ou nunca sondado. */
  liveState: 'up' | 'down' | null;
  /** Desde quando está no estado atual. */
  liveSince: string | null;
  /** Disponibilidade no tempo observado pela sonda, 0–1. `null` sem leituras. */
  uptime: number | null;
};

export type OperationsNetwork = {
  devices: OperationsBackboneNode[];
  /** Equipamentos sem uplink definido: são a raiz da árvore e, logo, SPOF. */
  rootDevices: Array<{ name: string; clientCount: number; mrrCve: number; mrrShare: number }>;
  /** Serviços ativos que não chegam a nenhum backbone — invisíveis no mapa. */
  servicesWithoutBackbone: Array<{ serviceId: number; clientId: number; clientName: string; zone: string | null }>;
  /** Preenchimento dos campos que tornam a rede diagnosticável. */
  identification: {
    backboneTotal: number;
    backboneWithIp: number;
    backboneWithMac: number;
    backboneWithSerial: number;
    assignmentTotal: number;
    assignmentWithIp: number;
    assignmentWithMac: number;
    assignmentWithSerial: number;
    /** Com MAC ou série — a mesma regra de identidade do aviso na topologia. */
    assignmentIdentified: number;
  };
  /** Fração acima da qual um único equipamento é considerado concentração. */
  concentrationThreshold: number;
  /** Estado da sonda ICMP: desligada, sem leituras, ou a medir. */
  probe: {
    enabled: boolean;
    lastRunAt: string | null;
    downCount: number;
    /** Equipamentos com IP que a sonda ainda não leu. */
    neverProbed: number;
  };
  findings: OperationsFinding[];
};

// ------------------------------------------------------------ clientes

export type OperationsCustomers = {
  active: number;
  suspended: number;
  cancelled: number;
  activeServices: number;
  /** Mensalidades + audiovisual mensal dos serviços ativos. */
  mrrCve: number;
  arpuCve: number;
  newClients: number;
  newClientsPrevious: number;
  activations: number;
  cancellations: number;
  workOrdersCreated: number;
  workOrdersCompleted: number;
  openWorkOrders: number;
  serviceEvents: number;
  /** Zonas ordenadas por nº de clientes ativos. */
  zones: Array<{ zone: string; clients: number; share: number }>;
  /** Serviços abaixo do preço de tabela do plano — receita por recuperar. */
  belowPlanPrice: { services: number; upliftCve: number };
  /** Dívida deixada por quem já cancelou. */
  cancelledDebtCve: number;
  findings: OperationsFinding[];
};

// -------------------------------------------------------------- parque

export type OperationsFleetModel = {
  catalogId: number;
  label: string;
  type: string;
  category: 'equipamento' | 'material';
  unitOfMeasure: string;
  deployed: number;
  stock: number;
  /** Sem reserva para um parque instalado é o sinal que interessa. */
  severity: OperationsSeverity;
};

export type OperationsFleet = {
  models: OperationsFleetModel[];
  deployedTotal: number;
  findings: OperationsFinding[];
};

// ------------------------------------------------------- acesso/QoS

/**
 * Camada de acesso. O schema não guarda sessões PPPoE nem filas de QoS, por
 * isso o que se reporta é capacidade: o que existe, o que não existe, e a
 * consequência de não existir. Melhor dizer "não é medido" do que inventar.
 */
export type OperationsAccessLayer = {
  pppoeTracked: false;
  qosTracked: false;
  sessionHistoryTracked: false;
  /** Nº de serviços ativos por raiz de uplink — mede a partilha do mesmo tubo. */
  sharedUplinkServices: number;
  /** Suspensões automáticas por dívida executadas na janela. Sempre 0 sem corte. */
  automaticSuspensions: number;
  /** Avisos de suspensão enviados sem execução — a prova de que o aviso não morde. */
  suspensionNoticesSent: number;
  findings: OperationsFinding[];
};

// ------------------------------------------------------------ cobrança

export type OperationsDebtor = {
  clientId: number;
  clientName: string;
  phone: string | null;
  zone: string | null;
  payments: number;
  amountCve: number;
  maxDaysOverdue: number;
  /** O cliente já saiu mas a dívida ficou. */
  clientCancelled: boolean;
};

export type OperationsCollectionCycle = {
  referenceMonth: string;
  issuedCve: number;
  collectedCve: number;
  /** 0–1. `null` quando nada foi emitido nesse mês. */
  rate: number | null;
};

export type OperationsBilling = {
  wallet: {
    paidCve: number;
    overdueCve: number;
    overdueCount: number;
    pendingNotDueCve: number;
    pendingNotDueCount: number;
    cancelledCve: number;
  };
  receivedThisWeekCve: number;
  receivedThisWeekCount: number;
  receivedPreviousWeekCve: number;
  receivedPreviousWeekCount: number;
  registeredTodayCve: number;
  registeredTodayCount: number;
  debtors: OperationsDebtor[];
  /** Últimos 6 ciclos, do mais antigo para o mais recente. */
  collection: OperationsCollectionCycle[];
  /** Vencimentos concentrados perto do dia de faturação automática. */
  calendarCollision: {
    autoBillingDay: number;
    nextBillingDate: string;
    dueBeforeBillingCve: number;
    dueBeforeBillingCount: number;
  } | null;
  documents: {
    invoices: number;
    receipts: number;
    paidWithoutReceipt: number;
  };
  methods: Array<{ method: string; count: number; amountCve: number }>;
  findings: OperationsFinding[];
};

// ----------------------------------------------------------- mensagens

export type OperationsMessaging = {
  whatsapp: {
    pending: number;
    failed: number;
    sentThisWeek: number;
    /** Erro mais frequente na fila parada — normalmente diz o que fazer. */
    lastError: string | null;
    lastErrorAt: string | null;
    /** Erro do provedor por subscrição/quota: bloqueio, não falha transitória. */
    providerBlocked: boolean;
  };
  sms: {
    enabled: boolean;
    paired: boolean;
    pending: number;
    failed: number;
    sentThisWeek: number;
  };
  findings: OperationsFinding[];
};

// -------------------------------------------------------------- sistema

export type OperationsSystem = {
  jobs: Array<{ job: string; status: 'ok' | 'skipped' | 'error'; ranAt: string; errors: number }>;
  lastBackupAt: string | null;
  backupAgeHours: number | null;
  activeUsers: number;
  /** Perfis distintos por nome real: 2 contas da mesma pessoa continua a ser 1. */
  distinctPeople: number;
  findings: OperationsFinding[];
};

// --------------------------------------------------------- conformidade

export type OperationsCompliance = {
  fiscalRegime: string;
  ivaRate: number;
  companyNifPresent: boolean;
  clientsTotal: number;
  clientsWithNif: number;
  clientsWithPhone: number;
  findings: OperationsFinding[];
};

// ---------------------------------------------------------------- topo

export type OperationsRisk = {
  code: string;
  title: string;
  detail: string;
  severity: OperationsSeverity;
  /** Exposição em CVE quando quantificável. */
  exposureCve: number | null;
};

export type OperationsAction = {
  code: string;
  title: string;
  detail: string;
  horizon: 'now' | 'week' | 'quarter';
  severity: OperationsSeverity;
  /** Ganho estimado em CVE quando quantificável. */
  upsideCve: number | null;
};

export type OperationsStatus = {
  generatedAt: string;
  period: OperationsPeriod;
  severity: OperationsSeverity;
  headline: string;
  network: OperationsNetwork;
  customers: OperationsCustomers;
  fleet: OperationsFleet;
  accessLayer: OperationsAccessLayer;
  billing: OperationsBilling;
  messaging: OperationsMessaging;
  system: OperationsSystem;
  compliance: OperationsCompliance;
  risks: OperationsRisk[];
  actions: OperationsAction[];
};

const SEVERITY_ORDER: Record<OperationsSeverity, number> = { green: 0, amber: 1, red: 2 };

/** A pior das severidades. Vazio devolve `green`. */
export function worstSeverity(values: OperationsSeverity[]): OperationsSeverity {
  return values.reduce<OperationsSeverity>(
    (worst, value) => (SEVERITY_ORDER[value] > SEVERITY_ORDER[worst] ? value : worst),
    'green'
  );
}

export const SEVERITY_LABELS: Record<OperationsSeverity, string> = {
  green: 'Normal',
  amber: 'Atenção',
  red: 'Crítico'
};

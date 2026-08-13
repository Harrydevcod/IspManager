import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single source of truth for the database shape.
 *
 * The DDL itself lives in the versioned migration chain (`migrations/`, ADR
 * 0003) — these declarations mirror it so application code gets typed rows,
 * autocomplete and refactor safety. The two are kept in lockstep by
 * `schema.drift.test.ts`, which fails if a migration adds/renames a column that
 * is not reflected here (or vice-versa). That test is what turns "column does
 * not exist" from a runtime surprise into a compile/CI failure.
 *
 * Convention: TS keys are camelCase, the SQL column name is the snake_case
 * argument. Types match SQLite affinity (integer / text / real).
 */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator', 'technician'] }).notNull(),
  fullName: text('full_name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const clients = sqliteTable('clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientCode: text('client_code').notNull().unique(),
  fullName: text('full_name').notNull(),
  phone: text('phone').unique(),
  email: text('email'),
  nif: text('nif').unique(),
  address: text('address'),
  island: text('island'),
  zone: text('zone'),
  status: text('status', { enum: ['active', 'suspended', 'cancelled'] }).notNull().default('active'),
  notes: text('notes'),
  admissionDate: text('admission_date'),
  defaultPaymentMethod: text('default_payment_method', { enum: ['numerario', 'transferencia', 'outro'] }),
  whatsappOptOut: integer('whatsapp_opt_out', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorUserId: integer('actor_user_id'),
  actorUsername: text('actor_username'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  summary: text('summary'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const internetPlans = sqliteTable('internet_plans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  downloadSpeed: text('download_speed').notNull().default(''),
  uploadSpeed: text('upload_speed').notNull().default(''),
  connectionType: text('connection_type').notNull().default('outro'),
  monthlyPriceCve: real('monthly_price_cve').notNull().default(0),
  installationFeeCve: real('installation_fee_cve').notNull().default(0),
  description: text('description'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  downloadMbps: integer('download_mbps'),
  uploadMbps: integer('upload_mbps')
});

export const services = sqliteTable('services', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull(),
  planId: integer('plan_id'),
  monthlyValueCve: real('monthly_value_cve').notNull().default(0),
  activationDate: text('activation_date'),
  dueDay: integer('due_day').notNull().default(1),
  status: text('status').notNull().default('active'),
  ipAddress: text('ip_address'),
  technicalNotes: text('technical_notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  audiovisualMode: text('audiovisual_mode').notNull().default('none'),
  audiovisualMonthlyCve: real('audiovisual_monthly_cve').notNull().default(0),
  audiovisualAnnualCve: real('audiovisual_annual_cve').notNull().default(0),
  pppoeUsername: text('pppoe_username'),
  pppoePassword: text('pppoe_password')
});

export const payments = sqliteTable('payments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull(),
  serviceId: integer('service_id').notNull(),
  referenceMonth: text('reference_month').notNull(),
  amountCve: real('amount_cve').notNull(),
  dueDate: text('due_date').notNull(),
  paymentDate: text('payment_date'),
  paymentMethod: text('payment_method'),
  status: text('status', { enum: ['pending', 'paid', 'overdue', 'cancelled'] }).notNull().default('pending'),
  invoiceNumber: text('invoice_number'),
  invoiceDate: text('invoice_date'),
  receiptNumber: text('receipt_number'),
  receiptDate: text('receipt_date'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const paymentLines = sqliteTable('payment_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paymentId: integer('payment_id').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  amountCve: real('amount_cve').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const equipmentCatalog = sqliteTable('equipment_catalog', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull().default('equipamento'),
  type: text('type').notNull(),
  brand: text('brand'),
  model: text('model').notNull(),
  description: text('description'),
  supplier: text('supplier'),
  unitOfMeasure: text('unit_of_measure').notNull().default('un'),
  isSerialized: integer('is_serialized', { mode: 'boolean' }).notNull().default(true),
  purchasePriceCve: real('purchase_price_cve').notNull().default(0),
  shippingCostCve: real('shipping_cost_cve').notNull().default(0),
  customsDutyCve: real('customs_duty_cve').notNull().default(0),
  otherCostsCve: real('other_costs_cve').notNull().default(0),
  sellingPriceCve: real('selling_price_cve').notNull().default(0),
  rentalFeeCve: real('rental_fee_cve').notNull().default(0),
  stockTotal: integer('stock_total').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const stockMovements = sqliteTable('stock_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  catalogId: integer('catalog_id').notNull(),
  type: text('type').notNull(),
  quantity: integer('quantity').notNull(),
  unitCostCve: real('unit_cost_cve').notNull().default(0),
  supplier: text('supplier'),
  reference: text('reference'),
  notes: text('notes'),
  serviceId: integer('service_id'),
  clientName: text('client_name'),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const serviceDeviceAssignments = sqliteTable('service_device_assignments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceId: integer('service_id').notNull(),
  catalogId: integer('catalog_id').notNull(),
  serialNumber: text('serial_number'),
  assetTag: text('asset_tag'),
  ipAddress: text('ip_address'),
  macAddress: text('mac_address'),
  technicianId: integer('technician_id'),
  notes: text('notes'),
  startDate: text('start_date').notNull().default("date('now')"),
  endDate: text('end_date'),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

// Serviços EXTRA servidos por uma atribuição física (migração 0030). O titular
// continua em service_device_assignments.service_id.
export const serviceDeviceShares = sqliteTable('service_device_shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  assignmentId: integer('assignment_id').notNull(),
  serviceId: integer('service_id').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const backboneDevices = sqliteTable('backbone_devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  catalogId: integer('catalog_id').notNull(),
  name: text('name').notNull(),
  serialNumber: text('serial_number'),
  assetTag: text('asset_tag'),
  ipAddress: text('ip_address'),
  macAddress: text('mac_address'),
  island: text('island'),
  zone: text('zone'),
  status: text('status', { enum: ['active', 'maintenance', 'retired'] }).notNull().default('active'),
  provisional: integer('provisional', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

/** Quem alimenta quem. Sem linhas para um equipamento = alimentado pela Internet. */
export const backboneLinks = sqliteTable('backbone_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceId: integer('device_id').notNull(),
  upstreamDeviceId: integer('upstream_device_id').notNull(),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const backboneAssignmentLinks = sqliteTable('backbone_assignment_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  backboneDeviceId: integer('backbone_device_id').notNull(),
  assignmentId: integer('assignment_id').notNull(),
  startedAt: text('started_at').notNull().default('CURRENT_TIMESTAMP'),
  endedAt: text('ended_at'),
  changeReason: text('change_reason'),
  createdBy: integer('created_by'),
  endedBy: integer('ended_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const serviceEvents = sqliteTable('service_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceId: integer('service_id').notNull(),
  eventType: text('event_type').notNull(),
  notes: text('notes'),
  technicianId: integer('technician_id'),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const serviceMaterialLines = sqliteTable('service_material_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceId: integer('service_id').notNull(),
  catalogId: integer('catalog_id').notNull(),
  quantity: integer('quantity').notNull(),
  unitCostCve: real('unit_cost_cve').notNull().default(0),
  notes: text('notes'),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const serviceInstallCosts = sqliteTable('service_install_costs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceId: integer('service_id').notNull(),
  kind: text('kind').notNull(),
  description: text('description'),
  amountCve: real('amount_cve').notNull().default(0),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const workOrders = sqliteTable('work_orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceId: integer('service_id'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('aguarda'),
  priority: text('priority').notNull().default('media'),
  eventType: text('event_type'),
  assignedTo: text('assigned_to'),
  scheduledAt: text('scheduled_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  completionNotes: text('completion_notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const investments = sqliteTable('investments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull().default('outro'),
  clientId: integer('client_id'),
  zone: text('zone'),
  description: text('description'),
  investmentDate: text('investment_date').notNull(),
  referenceMonth: text('reference_month').notNull(),
  status: text('status').notNull().default('ativo'),
  expectedMonthlyRevenueCve: real('expected_monthly_revenue_cve').notNull().default(0),
  totalCostCve: real('total_cost_cve').notNull().default(0),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  createdBy: integer('created_by'),
  supplier: text('supplier'),
  targetClients: integer('target_clients').notNull().default(1),
  installedClients: integer('installed_clients').notNull().default(0),
  desiredPaybackMonths: integer('desired_payback_months').notNull().default(6),
  desiredMarginPct: real('desired_margin_pct').notNull().default(30),
  monthlyOperationalCostCve: real('monthly_operational_cost_cve').notNull().default(0),
  accumulatedRevenueCve: real('accumulated_revenue_cve').notNull().default(0)
});

export const investmentItems = sqliteTable('investment_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  investmentId: integer('investment_id').notNull(),
  itemType: text('item_type').notNull().default('outro'),
  itemName: text('item_name').notNull(),
  quantity: real('quantity').notNull(),
  unitCostCve: real('unit_cost_cve').notNull(),
  totalCostCve: real('total_cost_cve').notNull(),
  quantityUsed: real('quantity_used').notNull().default(0)
});

// Associação exata investimento ↔ vários clientes (antena de transmissão que
// serve um conjunto específico de clientes, migração 0027).
export const investmentClients = sqliteTable('investment_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  investmentId: integer('investment_id').notNull(),
  clientId: integer('client_id').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP')
});

export const expenses = sqliteTable('expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull().default('outros'),
  description: text('description').notNull(),
  amountCve: real('amount_cve').notNull(),
  expenseDate: text('expense_date').notNull(),
  referenceMonth: text('reference_month').notNull(),
  supplier: text('supplier'),
  invoiceReference: text('invoice_reference'),
  notes: text('notes'),
  investmentId: integer('investment_id'),
  zone: text('zone'),
  clientId: integer('client_id'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  createdBy: integer('created_by')
});

export const expenseTemplates = sqliteTable('expense_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category').notNull().default('outros'),
  amountCve: real('amount_cve').notNull(),
  dayOfMonth: integer('day_of_month').notNull().default(1),
  supplier: text('supplier'),
  notes: text('notes'),
  investmentId: integer('investment_id'),
  zone: text('zone'),
  clientId: integer('client_id'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastGeneratedMonth: text('last_generated_month'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  createdBy: integer('created_by')
});

export const clientDuplicateDismissals = sqliteTable('client_duplicate_dismissals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientIdLow: integer('client_id_low').notNull(),
  clientIdHigh: integer('client_id_high').notNull(),
  dismissedBy: integer('dismissed_by'),
  dismissedAt: text('dismissed_at').notNull().default('CURRENT_TIMESTAMP')
});

export const whatsappNotices = sqliteTable('whatsapp_notices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paymentId: integer('payment_id').notNull(),
  clientId: integer('client_id').notNull(),
  noticeType: text('notice_type').notNull(),
  origin: text('origin').notNull().default('auto'),
  phone: text('phone').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('sent'),
  error: text('error'),
  sentAt: text('sent_at').notNull().default('CURRENT_TIMESTAMP'),
  outboxId: integer('outbox_id')
});

export const whatsappOutbox = sqliteTable('whatsapp_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  toPhone: text('to_phone').notNull(),
  kind: text('kind').notNull().default('text'),
  body: text('body'),
  docPaymentId: integer('doc_payment_id'),
  docKind: text('doc_kind'),
  clientId: integer('client_id'),
  origin: text('origin').notNull().default('manual'),
  provider: text('provider').notNull().default('ultramsg'),
  providerMessageId: text('provider_message_id'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lastError: text('last_error'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const smsOutbox = sqliteTable('sms_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id'),
  paymentId: integer('payment_id'),
  serviceId: integer('service_id'),
  eventType: text('event_type').notNull(),
  toPhone: text('to_phone').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('pending_dispatch'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lastError: text('last_error'),
  nextAttemptAt: text('next_attempt_at'),
  androidRequestId: text('android_request_id'),
  approvedAt: text('approved_at'),
  sentAt: text('sent_at'),
  rejectedAt: text('rejected_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  failedAt: text('failed_at')
});

export const smsCompanionPairing = sqliteTable('sms_companion_pairing', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  deviceName: text('device_name'),
  baseUrl: text('base_url'),
  pairingKeyHash: text('pairing_key_hash'),
  pairedAt: text('paired_at'),
  revokedAt: text('revoked_at'),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

// Contador sequencial por série/ano dos documentos (migration 0020). A PK real é
// composta (series, year); o guarda de drift compara a flag PK por coluna, por
// isso modela-se `series` como PK — a tabela é só acedida por SQL cru em
// numbering.ts, nunca pelo query builder. ponytail: PK composta como single-col,
// suficiente porque é uma tabela-contador congelada.
export const documentSequences = sqliteTable('document_sequences', {
  series: text('series').primaryKey(),
  year: integer('year').notNull(),
  lastNumber: integer('last_number').notNull().default(0)
});

// Rate-limit / lockout do login (migration 0022).
export const loginThrottle = sqliteTable('login_throttle', {
  identifier: text('identifier').primaryKey(),
  failCount: integer('fail_count').notNull().default(0),
  firstFailedAt: text('first_failed_at').notNull().default('CURRENT_TIMESTAMP'),
  lastFailedAt: text('last_failed_at').notNull().default('CURRENT_TIMESTAMP'),
  lockedUntil: text('locked_until')
});

// Observabilidade dos jobs in-process (migration 0023).
export const jobRuns = sqliteTable('job_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  job: text('job').notNull(),
  status: text('status').notNull(),
  ranAt: text('ran_at').notNull().default('CURRENT_TIMESTAMP'),
  durationMs: integer('duration_ms'),
  summaryJson: text('summary_json')
});

// Sonda de rede: estado atual por equipamento (migration 0037).
export const networkProbeState = sqliteTable('network_probe_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  targetKind: text('target_kind').notNull(),
  targetId: integer('target_id').notNull(),
  ipAddress: text('ip_address').notNull(),
  state: text('state').notNull(),
  rttMs: integer('rtt_ms'),
  consecutiveFails: integer('consecutive_fails').notNull().default(0),
  lastOkAt: text('last_ok_at'),
  lastChangeAt: text('last_change_at').notNull().default('CURRENT_TIMESTAMP'),
  checkedAt: text('checked_at').notNull().default('CURRENT_TIMESTAMP')
});

// Sonda de rede: só as transições de estado (migration 0037).
export const networkProbeEvents = sqliteTable('network_probe_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  targetKind: text('target_kind').notNull(),
  targetId: integer('target_id').notNull(),
  ipAddress: text('ip_address').notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  at: text('at').notNull().default('CURRENT_TIMESTAMP'),
  durationSeconds: integer('duration_seconds'),
  gapBefore: integer('gap_before').notNull().default(0)
});

/** Realidade lida do MikroTik por serviço. A intenção vive em `services.status`. */
export const serviceNetworkState = sqliteTable('service_network_state', {
  serviceId: integer('service_id').primaryKey(),
  secretId: text('secret_id'),
  routerEnabled: integer('router_enabled'),
  desiredEnabled: integer('desired_enabled').notNull().default(1),
  rateLimit: text('rate_limit'),
  online: integer('online').notNull().default(0),
  address: text('address'),
  uptime: text('uptime'),
  lastOnlineAt: text('last_online_at'),
  divergence: text('divergence'),
  lastError: text('last_error'),
  checkedAt: text('checked_at').notNull().default('CURRENT_TIMESTAMP')
});

/**
 * Inferred row types — one `select` (read) and `insert` (write) per table.
 * Prefer these over hand-written `as { ... }` casts in raw queries: renaming a
 * column in the schema above propagates here and breaks the build at every use
 * site, which is the whole point of declaring the schema.
 */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type InternetPlan = typeof internetPlans.$inferSelect;
export type NewInternetPlan = typeof internetPlans.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentLine = typeof paymentLines.$inferSelect;
export type NewPaymentLine = typeof paymentLines.$inferInsert;
export type EquipmentCatalogItem = typeof equipmentCatalog.$inferSelect;
export type NewEquipmentCatalogItem = typeof equipmentCatalog.$inferInsert;
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type ServiceDeviceAssignment = typeof serviceDeviceAssignments.$inferSelect;
export type NewServiceDeviceAssignment = typeof serviceDeviceAssignments.$inferInsert;
export type ServiceDeviceShare = typeof serviceDeviceShares.$inferSelect;
export type NewServiceDeviceShare = typeof serviceDeviceShares.$inferInsert;
export type BackboneDevice = typeof backboneDevices.$inferSelect;
export type NewBackboneDevice = typeof backboneDevices.$inferInsert;
export type BackboneLink = typeof backboneLinks.$inferSelect;
export type NewBackboneLink = typeof backboneLinks.$inferInsert;
export type BackboneAssignmentLink = typeof backboneAssignmentLinks.$inferSelect;
export type NewBackboneAssignmentLink = typeof backboneAssignmentLinks.$inferInsert;
export type ServiceEvent = typeof serviceEvents.$inferSelect;
export type NewServiceEvent = typeof serviceEvents.$inferInsert;
export type ServiceMaterialLine = typeof serviceMaterialLines.$inferSelect;
export type NewServiceMaterialLine = typeof serviceMaterialLines.$inferInsert;
export type ServiceInstallCost = typeof serviceInstallCosts.$inferSelect;
export type NewServiceInstallCost = typeof serviceInstallCosts.$inferInsert;
export type WorkOrder = typeof workOrders.$inferSelect;
export type NewWorkOrder = typeof workOrders.$inferInsert;
export type Investment = typeof investments.$inferSelect;
export type NewInvestment = typeof investments.$inferInsert;
export type InvestmentItem = typeof investmentItems.$inferSelect;
export type NewInvestmentItem = typeof investmentItems.$inferInsert;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type ExpenseTemplate = typeof expenseTemplates.$inferSelect;
export type NewExpenseTemplate = typeof expenseTemplates.$inferInsert;
export type ClientDuplicateDismissal = typeof clientDuplicateDismissals.$inferSelect;
export type WhatsappNotice = typeof whatsappNotices.$inferSelect;
export type NewWhatsappNotice = typeof whatsappNotices.$inferInsert;
export type WhatsappOutboxRow = typeof whatsappOutbox.$inferSelect;
export type NewWhatsappOutboxRow = typeof whatsappOutbox.$inferInsert;
export type SmsOutboxRow = typeof smsOutbox.$inferSelect;
export type NewSmsOutboxRow = typeof smsOutbox.$inferInsert;
export type SmsCompanionPairing = typeof smsCompanionPairing.$inferSelect;
export type DocumentSequence = typeof documentSequences.$inferSelect;
export type LoginThrottleRow = typeof loginThrottle.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type NewJobRun = typeof jobRuns.$inferInsert;
export type NetworkProbeStateRow = typeof networkProbeState.$inferSelect;
export type NetworkProbeEventRow = typeof networkProbeEvents.$inferSelect;
export type ServiceNetworkStateRow = typeof serviceNetworkState.$inferSelect;

/** Commercial offers are independent of billing and inventory. Money is in centavos. */
export const INFORMATIVE_TYPE_LABELS = { proposal: 'Proposta comercial', quotation: 'Orçamento', proforma: 'Fatura proforma' } as const;
export type InformativeDocumentType = keyof typeof INFORMATIVE_TYPE_LABELS;
export type PaymentRequest = { amountCentavos: number; description: string; conditions: string; dueDate?: string | null };
export type DocumentBankAccount = { bankName: string; accountName: string; accountNumber: string; reference: string };
export const PROPOSAL_STATUS_LABELS = {
  draft: 'Rascunho', issued: 'Emitida', accepted: 'Aceite', refused: 'Recusada',
  expired: 'Expirada', cancelled: 'Cancelada', superseded: 'Substituída'
} as const;
export type ProposalStatus = keyof typeof PROPOSAL_STATUS_LABELS;
export type ProposalPeriod = 'once' | 'monthly';
export type ProposalLineKind = 'plan' | 'installation' | 'product' | 'free';
export type ProposalRecipient = {
  name: string; nif: string; phone: string; email: string; address: string;
};
export type ProposalLineInput = {
  kind: ProposalLineKind; description: string; period: ProposalPeriod;
  quantity: number; unitPriceCentavos: number; planId?: number | null; catalogId?: number | null; articleId?: number | null;
};
export type ProposalDraftInput = {
  documentType?: InformativeDocumentType; paymentRequest?: PaymentRequest | null;
  clientId: number | null; recipient: ProposalRecipient; title: string;
  validUntil: string; conditions: string; lines: ProposalLineInput[];
};
export type ProposalLine = ProposalLineInput & { id: number; sortOrder: number; totalCentavos: number; itemCode?: string | null; itemNote?: string | null };
export type ProposalCompany = {
  companyName: string; nif: string; phone: string; email: string; address: string;
  island: string; currencyCode: string; ivaRate: number; fiscalRegime: 'normal' | 'rempe';
  showIva: boolean; legalNotes: string; productPolicy?: string;
};
export type ProposalTax = {
  subtotalCentavos: number; ivaCentavos: number; totalCentavos: number;
  ivaRate: number; isExempt: boolean; exemptReason: string;
};
export type ProposalSnapshot = {
  paymentRequest?: PaymentRequest | null; bankAccounts?: DocumentBankAccount[];
  company: ProposalCompany; onceTax: ProposalTax; monthlyTax: ProposalTax;
};
export type ProposalAction = 'issue' | 'deliver' | 'accept' | 'refuse' | 'cancel' | 'revise';
export type ProposalDelivery = {
  id: number; deliveredAt: string; channel: string; note: string; actorUserId: number | null;
};
export type ProposalSummary = {
  documentType: InformativeDocumentType;
  id: number; number: string | null; title: string; recipientName: string;
  clientId: number | null; status: ProposalStatus; version: number;
  validUntil: string; issuedAt: string | null; createdAt: string;
  onceTotalCentavos: number; monthlyTotalCentavos: number; previousId: number | null;
};
export type Proposal = ProposalSummary & {
  paymentRequest: PaymentRequest | null;
  recipient: ProposalRecipient; conditions: string; lines: ProposalLine[];
  snapshot: ProposalSnapshot | null; createdBy: number | null;
  decisionAt: string | null; acceptedBy: string | null; decisionNote: string | null;
  cancellationReason: string | null; deliveries: ProposalDelivery[];
  chain: ProposalSummary[]; allowedActions: ProposalAction[];
};
export type ProposalList = { items: ProposalSummary[]; total: number; page: number; pageSize: number };

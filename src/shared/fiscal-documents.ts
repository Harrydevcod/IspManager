export type FiscalDocumentType = "invoice" | "receipt" | "sale_ticket";
export const FISCAL_TYPE_LABELS = {
  invoice: "Fatura",
  receipt: "Recibo",
  sale_ticket: "Talão de venda",
} as const;
export type FiscalDocument = {
  source: "payment" | "receipt";
  sourceId: number;
  paymentId: number;
  documentType: FiscalDocumentType;
  number: string;
  date: string;
  clientId: number;
  clientName: string;
  amountCve: number;
  status: "pending" | "overdue" | "paid" | "issued" | "cancelled";
};
export type FiscalDocumentList = {
  items: FiscalDocument[];
  total: number;
  page: number;
  pageSize: number;
};

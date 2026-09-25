export type BankAccountForm = {
  bankName: string;
  accountName: string;
  accountNumber: string;
  reference: string;
};

export type SettingsFormState = {
  companyName: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  island: string;
  bankAccounts: BankAccountForm[];
  defaultDueDay: string;
  autoBillingDay: string;
  audiovisualEnabled: boolean;
  audiovisualLabel: string;
  audiovisualMonthlyCve: string;
  audiovisualAnnualCve: string;
  installationFeeCve: string;
  currencyCode: string;
  invoicePrefix: string;
  receiptPrefix: string;
  ivaRate: string;
  fiscalRegime: 'normal' | 'rempe';
  showIva: boolean;
  printQrCode: boolean;
  printRentalLines: boolean;
  legalNotes: string;
  whatsappTemplate: string;
  whatsappTestTemplate: string;
  whatsappInvoiceReadyTemplate: string;
  whatsappReceiptTemplate: string;
  whatsappOverdueTemplate: string;
  whatsappSuspensionTemplate: string;
  whatsappSuspensionNoticeDays: string;
  autoNoticesEnabled: boolean;
  noticeCooldownDays: string;
  ultraMsgInstanceId: string;
  /** Só um token novo; vazio = manter o guardado. */
  ultraMsgToken: string;
  ultraMsgTokenConfigured?: boolean;
  smsCompanionEnabled: boolean;
  smsCompanionBaseUrl: string;
  smsDispatchIntervalSeconds: string;
  smsRetryGraceMinutes: string;
  smsInvoiceIssuedTemplate: string;
  smsReceiptConfirmedTemplate: string;
  smsPaymentOverdueTemplate: string;
  smsSuspensionNoticeTemplate: string;
  networkProbeEnabled: boolean;
  networkProbeIntervalSeconds: string;
  networkProbeIncludeClients: boolean;
  networkProbeFailThreshold: string;
  routerosEnabled: boolean;
  routerosHost: string;
  routerosPort: string;
  routerosUser: string;
  /** Só uma senha nova; vazia = manter a guardada. */
  routerosPassword: string;
  routerosPasswordConfigured?: boolean;
  routerosTlsCert: string;
  routerosDryRun: boolean;
  routerosIntervalSeconds: string;
  routerosMaxDisablesPerRun: string;
  autoSuspensionEnabled: boolean;
  autoSuspensionGraceDays: string;
  autoSuspensionIntervalMinutes: string;
  autoSuspensionMaxPerRun: string;
  autoSuspensionMaxPercent: string;
};

export type UpdateField = (field: keyof SettingsFormState, value: string) => void;
export type ToggleField = (field: keyof SettingsFormState, value: boolean) => void;

export function templateRows(value: string) {
  const explicitLines = value.split('\n').length;
  const wrappedLines = Math.ceil(value.length / 92);
  return Math.min(4, Math.max(2, explicitLines, wrappedLines));
}

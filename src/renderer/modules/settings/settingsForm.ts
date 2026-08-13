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
  ultraMsgToken: string;
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
  routerosPassword: string;
  routerosTlsFingerprint: string;
  routerosDryRun: boolean;
  routerosIntervalSeconds: string;
  routerosMaxDisablesPerRun: string;
};

export const emptyBankAccount: BankAccountForm = {
  bankName: '',
  accountName: '',
  accountNumber: '',
  reference: ''
};

export type UpdateField = (field: keyof SettingsFormState, value: string) => void;
export type ToggleField = (field: keyof SettingsFormState, value: boolean) => void;

export function templateRows(value: string) {
  const explicitLines = value.split('\n').length;
  const wrappedLines = Math.ceil(value.length / 92);
  return Math.min(4, Math.max(2, explicitLines, wrappedLines));
}

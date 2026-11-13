/** O aviso de suspensão ao cliente sai, e o operador é avisado, esta semana antes do corte. */
export const SUSPENSION_NOTICE_LEAD_DAYS = 7;

/** Estado na fila do último aviso de um canal (`sms_outbox` / `whatsapp_outbox`). */
export type NoticeDelivery = { status: string; at: string };

/** Um serviço que o corte automático vai suspender em breve. */
export type UpcomingSuspension = {
  serviceId: number;
  clientId: number;
  clientName: string;
  clientCode: string;
  phone: string | null;
  paymentId: number;
  invoiceNumber: string | null;
  dueDate: string;
  balanceCve: number;
  /** Primeiro dia em que o job corta (`cutDate`); hoje se já passou. */
  cutDate: string;
  sms: NoticeDelivery | null;
  whatsapp: NoticeDelivery | null;
};

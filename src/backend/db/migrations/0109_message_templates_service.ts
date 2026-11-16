import type { Migration } from './types';

/**
 * As mensagens de fatura e recibo passam a dizer o serviço ({servico}) e o mês por extenso também
 * na suspensão. Como na 0093: um modelo guardado igual ao antigo texto por omissão passa ao novo;
 * um personalizado fica como está (o ecrã oferece "Usar texto recomendado").
 * Um modelo de WhatsApp ligado a um modelo aprovado da Meta também fica: o texto tem de bater com
 * o aprovado, e mudá-lo aqui calava esse aviso até a Meta aprovar o novo.
 * Textos por extenso: a migração é imutável, não pode importar as constantes.
 */
const migration: Migration = {
  version: 109,
  name: 'message_templates_service',
  sql: `
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'A sua fatura {fatura} de {mes}, referente a {servico}, já está disponível.' || char(10) || 'Valor: {valor}' || char(10) || 'Vencimento: {vencimento}' || char(10) || '{link}' || char(10) || '' || char(10) || 'Obrigado pela preferência.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappInvoiceReadyTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'A sua fatura {fatura} de {mes} já está disponível.' || char(10) || 'Valor: {valor}' || char(10) || 'Vencimento: {vencimento}' || char(10) || '{link}' || char(10) || '' || char(10) || 'Obrigado pela preferência.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateInvoice' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'Confirmamos a receção do seu pagamento de {valor}, referente a {servico} de {mes}. O recibo {recibo} já foi emitido.' || char(10) || '' || char(10) || 'Obrigado pela confiança.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappReceiptTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'Confirmamos a receção do seu pagamento de {valor}, referente a {mes}. O recibo {recibo} já foi emitido.' || char(10) || '' || char(10) || 'Obrigado pela confiança.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateReceipt' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'Lembramos que a sua fatura {fatura} de {mes}, referente a {servico}, no valor de {valor}, vence a {vencimento}.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já efetuou o pagamento, agradecemos e pode ignorar esta mensagem.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappReminderTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'Lembramos que a sua fatura {fatura} de {mes}, no valor de {valor}, vence a {vencimento}.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já efetuou o pagamento, agradecemos e pode ignorar esta mensagem.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateReminder' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'Ainda não registámos o pagamento da fatura {fatura} de {mes}, referente a {servico} ({valor}), com vencimento a {vencimento}. Pedimos a gentileza de regularizar assim que possível.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já pagou, por favor ignore esta mensagem. Para qualquer dúvida, estamos ao dispor.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappOverdueTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'Ainda não registámos o pagamento da fatura {fatura} de {mes} ({valor}), com vencimento a {vencimento}. Pedimos a gentileza de regularizar assim que possível.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já pagou, por favor ignore esta mensagem. Para qualquer dúvida, estamos ao dispor.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateOverdue' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'A fatura {fatura} de {mes}, referente a {servico} ({valor}), continua por regularizar há {dias_atraso}. Para manter o seu serviço sem interrupções, pedimos que efetue o pagamento com a maior brevidade.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se precisar de combinar outra forma de pagamento, fale connosco.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappWarningTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'A fatura {fatura} de {mes} ({valor}) continua por regularizar há {dias_atraso}. Para manter o seu serviço sem interrupções, pedimos que efetue o pagamento com a maior brevidade.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se precisar de combinar outra forma de pagamento, fale connosco.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateWarning' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente,' || char(10) || '' || char(10) || 'A fatura {fatura} de {mes}, referente a {servico} ({valor}), está em atraso há {dias_atraso}. Sem regularização, o serviço de internet será suspenso a {data_suspensao}.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já pagou, ignore esta mensagem. Estamos disponíveis para ajudar.' || char(10) || '{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappSuspensionTemplate' AND value = 'Caro cliente,' || char(10) || '' || char(10) || 'A fatura {fatura} ({valor}) está em atraso há {dias_atraso}. Sem regularização, o serviço de internet será suspenso a {data_suspensao}.' || char(10) || '{link}' || char(10) || '' || char(10) || 'Se já pagou, ignore esta mensagem. Estamos disponíveis para ajudar.' || char(10) || '{empresa}'
        AND NOT EXISTS (SELECT 1 FROM app_settings m WHERE m.key = 'metaTemplateSuspension' AND trim(m.value) <> '');
    UPDATE app_settings SET value = 'Caro cliente, a fatura {fatura} de {mes} ({servico}), no valor de {valor}, foi emitida. Vence a {vencimento}. Obrigado, {empresa}', updated_at = datetime('now')
      WHERE key = 'smsInvoiceIssuedTemplate' AND value = 'Caro cliente, a sua fatura {fatura} de {mes}, no valor de {valor}, foi emitida. Vencimento: {vencimento}. Obrigado, {empresa}';
    UPDATE app_settings SET value = 'Caro cliente, confirmamos o pagamento de {valor} de {servico}, {mes}. Recibo {recibo}. Muito obrigado, {empresa}', updated_at = datetime('now')
      WHERE key = 'smsReceiptConfirmedTemplate' AND value = 'Caro cliente, confirmamos o pagamento de {valor} referente a {mes}. Recibo {recibo}. Muito obrigado, {empresa}';
    UPDATE app_settings SET value = 'Caro cliente, a fatura {fatura} de {mes} ({servico}, {valor}) venceu a {vencimento}. Caso tenha pago, ignore. {empresa}', updated_at = datetime('now')
      WHERE key = 'smsPaymentOverdueTemplate' AND value = 'Caro cliente, a fatura {fatura} de {mes} ({valor}) venceu a {vencimento}. Pedimos que regularize. Caso tenha pago, ignore. {empresa}';
    UPDATE app_settings SET value = 'Caro cliente, a fatura {fatura} ({servico}, {mes}, {valor}) esta por pagar. A internet pode ser suspensa a {data_suspensao}. {empresa}', updated_at = datetime('now')
      WHERE key = 'smsSuspensionNoticeTemplate' AND value = 'Caro cliente, a fatura {fatura} ({valor}) continua por pagar. A internet pode ser suspensa a {data_suspensao}. Caso tenha pago, ignore. {empresa}';
  `
};
export default migration;

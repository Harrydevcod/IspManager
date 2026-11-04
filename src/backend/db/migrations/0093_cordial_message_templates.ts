import type { Migration } from './types';

/**
 * Mensagens aos clientes mais cordiais: "Caro cliente", mês por extenso, valor
 * em 2.500$00 e "se já pagou, ignore". A gravação das Definições guarda os
 * modelos na base, por isso mudar os textos por omissão não chegava lá.
 *
 * 1. Um modelo igual ao antigo texto por omissão (nunca editado) passa ao novo.
 * 2. Num modelo personalizado só se limpa o que agora sairia duplicado:
 *    `{valor}` já traz o cifrão ("2.500$00 CVE") e `{dias_*}` já traz a
 *    palavra ("5 dias dia(s)").
 * Textos escritos aqui por extenso: a migração é imutável, não pode importar
 * as constantes, que vão continuar a mudar.
 */
const migration: Migration = {
  version: 93,
  name: 'cordial_message_templates',
  sql: `
    UPDATE app_settings SET value = 'Caro cliente, fala a {empresa}. Entramos em contacto a propósito do seu serviço de internet.', updated_at = datetime('now')
      WHERE key = 'whatsappTemplate' AND value = 'Ola {nome}, somos da {empresa}. Entramos em contacto sobre o seu servico de internet.';
    UPDATE app_settings SET value = 'Caro cliente, esta é uma mensagem de teste da {empresa}. A ligação ao WhatsApp está a funcionar.', updated_at = datetime('now')
      WHERE key = 'whatsappTestTemplate' AND value = 'Teste WhatsApp - {empresa}. Ola {nome}, esta mensagem confirma que a integracao WhatsApp esta ativa.';
    UPDATE app_settings SET value = 'Caro cliente,

A sua fatura {fatura} de {mes} já está disponível.
Valor: {valor}
Vencimento: {vencimento}
{link}

Obrigado pela preferência.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappInvoiceReadyTemplate' AND value = 'Ola {nome}, a sua fatura {fatura} de {mes} no valor de {valor} CVE ja esta pronta. Vencimento: {vencimento}. {empresa} {link}';
    UPDATE app_settings SET value = 'Caro cliente,

Confirmamos a receção do seu pagamento de {valor}, referente a {mes}. O recibo {recibo} já foi emitido.

Obrigado pela confiança.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappReceiptTemplate' AND value = 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. O seu recibo {recibo} foi emitido. Obrigado, {empresa}.';
    UPDATE app_settings SET value = 'Caro cliente,

Lembramos que a sua fatura {fatura} de {mes}, no valor de {valor}, vence a {vencimento}.
{link}

Se já efetuou o pagamento, agradecemos e pode ignorar esta mensagem.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappReminderTemplate' AND value = 'Ola {nome}, lembramos que a sua fatura {fatura} de {mes}, no valor de {valor} CVE, vence a {vencimento}. {empresa} {link}';
    UPDATE app_settings SET value = 'Caro cliente,

Ainda não registámos o pagamento da fatura {fatura} de {mes} ({valor}), com vencimento a {vencimento}. Pedimos a gentileza de regularizar assim que possível.
{link}

Se já pagou, por favor ignore esta mensagem. Para qualquer dúvida, estamos ao dispor.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappOverdueTemplate' AND value = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, esta em atraso desde {vencimento}. Por favor regularize para evitar constrangimentos. {empresa} {link}';
    UPDATE app_settings SET value = 'Caro cliente,

A fatura {fatura} de {mes} ({valor}) continua por regularizar há {dias_atraso}. Para manter o seu serviço sem interrupções, pedimos que efetue o pagamento com a maior brevidade.
{link}

Se precisar de combinar outra forma de pagamento, fale connosco.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappWarningTemplate' AND value = 'Ola {nome}, a sua fatura {fatura} de {mes} continua por regularizar ha {dias_atraso} dia(s). Pedimos que efetue o pagamento o quanto antes para manter o servico ativo. {empresa} {link}';
    UPDATE app_settings SET value = 'Caro cliente,

A fatura {fatura} ({valor}) está em atraso há {dias_atraso}. Sem regularização, o serviço de internet será suspenso a {data_suspensao}.
{link}

Se já pagou, ignore esta mensagem. Estamos disponíveis para ajudar.
{empresa}', updated_at = datetime('now')
      WHERE key = 'whatsappSuspensionTemplate' AND value = 'Ola {nome}, a sua fatura {fatura} continua em atraso ha {dias_atraso} dia(s). O servico podera ser suspenso apos {dias_suspensao} dia(s) de atraso. Regularize para evitar corte. {empresa} {link}';
    UPDATE app_settings SET value = 'Caro cliente, a sua fatura {fatura} de {mes}, no valor de {valor}, foi emitida. Vencimento: {vencimento}. Obrigado, {empresa}', updated_at = datetime('now')
      WHERE key = 'smsInvoiceIssuedTemplate' AND value = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, foi emitida. Vencimento: {vencimento}. {empresa}';
    UPDATE app_settings SET value = 'Caro cliente, confirmamos o pagamento de {valor} referente a {mes}. Recibo {recibo}. Muito obrigado, {empresa}', updated_at = datetime('now')
      WHERE key = 'smsReceiptConfirmedTemplate' AND value = 'Ola {nome}, confirmamos o recebimento de {valor} CVE referente a {mes}. Recibo {recibo}. Obrigado, {empresa}.';
    UPDATE app_settings SET value = 'Caro cliente, a fatura {fatura} de {mes} ({valor}) venceu a {vencimento}. Pedimos que regularize. Caso tenha pago, ignore. {empresa}', updated_at = datetime('now')
      WHERE key = 'smsPaymentOverdueTemplate' AND value = 'Ola {nome}, a fatura {fatura} esta em atraso ha {dias_atraso} dia(s). Valor: {valor} CVE. Regularize para evitar constrangimentos. {empresa}';
    UPDATE app_settings SET value = 'Caro cliente, a fatura {fatura} ({valor}) continua por pagar. A internet pode ser suspensa a {data_suspensao}. Caso tenha pago, ignore. {empresa}', updated_at = datetime('now')
      WHERE key = 'smsSuspensionNoticeTemplate' AND value = 'Ola {nome}, a fatura {fatura} continua em atraso. O servico podera ser suspenso apos {dias_suspensao} dia(s) de atraso. {empresa}';
    UPDATE app_settings SET
      value = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(value,
        '{valor} CVE', '{valor}'),
        '{dias_atraso} dia(s)', '{dias_atraso}'), '{dias_atraso} dias', '{dias_atraso}'),
        '{dias_suspensao} dia(s)', '{dias_suspensao}'), '{dias_suspensao} dias', '{dias_suspensao}'),
        '{dias_atraso} dia', '{dias_atraso}'),
      updated_at = datetime('now')
      WHERE key IN ('whatsappTemplate', 'whatsappTestTemplate', 'whatsappInvoiceReadyTemplate', 'whatsappReceiptTemplate', 'whatsappReminderTemplate', 'whatsappOverdueTemplate', 'whatsappWarningTemplate', 'whatsappSuspensionTemplate', 'smsInvoiceIssuedTemplate', 'smsReceiptConfirmedTemplate', 'smsPaymentOverdueTemplate', 'smsSuspensionNoticeTemplate')
        AND (value LIKE '%{valor} CVE%' OR value LIKE '%{dias_atraso} dia%' OR value LIKE '%{dias_suspensao} dia%');
  `
};

export default migration;

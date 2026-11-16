import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';
import { fallbackWhatsappReceiptTemplate } from '../../../shared/whatsapp';
import { fallbackSmsPaymentOverdueTemplate } from '../../../shared/sms';

let db: Database.Database;
afterEach(() => db?.close());

// Os textos por omissão de antes da 0109, por extenso como na migração.
const OLD_RECEIPT = 'Caro cliente,\n\nConfirmamos a receção do seu pagamento de {valor}, referente a {mes}. O recibo {recibo} já foi emitido.\n\nObrigado pela confiança.\n{empresa}';
const OLD_OVERDUE = 'Caro cliente,\n\nAinda não registámos o pagamento da fatura {fatura} de {mes} ({valor}), com vencimento a {vencimento}. Pedimos a gentileza de regularizar assim que possível.\n{link}\n\nSe já pagou, por favor ignore esta mensagem. Para qualquer dúvida, estamos ao dispor.\n{empresa}';
const OLD_SMS_OVERDUE = 'Caro cliente, a fatura {fatura} de {mes} ({valor}) venceu a {vencimento}. Pedimos que regularize. Caso tenha pago, ignore. {empresa}';

test('0109 leva {servico} aos modelos nunca editados; os personalizados e os ligados à Meta ficam', () => {
  db = new Database(':memory:');
  runMigrations(db, migrations.filter((migration) => migration.version < 109));
  const put = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
  put.run('whatsappReceiptTemplate', OLD_RECEIPT);
  put.run('smsPaymentOverdueTemplate', OLD_SMS_OVERDUE);
  put.run('whatsappOverdueTemplate', OLD_OVERDUE);
  put.run('metaTemplateOverdue', 'aviso_atraso|pt_PT');
  put.run('whatsappInvoiceReadyTemplate', 'Olá {nome}, a fatura {fatura} está pronta.');

  runMigrations(db); runMigrations(db);

  const value = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string }).value;
  expect(value('whatsappReceiptTemplate')).toBe(fallbackWhatsappReceiptTemplate);
  expect(value('smsPaymentOverdueTemplate')).toBe(fallbackSmsPaymentOverdueTemplate);
  expect(value('whatsappOverdueTemplate')).toBe(OLD_OVERDUE);
  expect(value('whatsappInvoiceReadyTemplate')).toBe('Olá {nome}, a fatura {fatura} está pronta.');
});

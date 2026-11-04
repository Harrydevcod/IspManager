import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { runMigrations } from '../migrate';
import { migrations } from '.';

let db: Database.Database;
afterEach(() => db?.close());

const OLD_OVERDUE = 'Ola {nome}, a sua fatura {fatura} de {mes}, no valor de {valor} CVE, esta em atraso desde {vencimento}. Por favor regularize para evitar constrangimentos. {empresa} {link}';
const OLD_SMS_OVERDUE = 'Ola {nome}, a fatura {fatura} esta em atraso ha {dias_atraso} dia(s). Valor: {valor} CVE. Regularize para evitar constrangimentos. {empresa}';

test('0093 troca os modelos nunca editados e só limpa os personalizados', () => {
  db = new Database(':memory:');
  runMigrations(db, migrations.filter((migration) => migration.version < 93));
  const put = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
  put.run('whatsappOverdueTemplate', OLD_OVERDUE);
  put.run('smsPaymentOverdueTemplate', OLD_SMS_OVERDUE);
  put.run('whatsappSuspensionTemplate', 'Bom dia {nome}: deve {valor} CVE há {dias_atraso} dias, corte em {dias_suspensao} dia(s).');
  put.run('companyName', 'Valor {valor} CVE');

  runMigrations(db); runMigrations(db);

  const value = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string }).value;
  // char(10) no SQL: quebra de linha real, sem \r de um checkout CRLF.
  expect(value('whatsappOverdueTemplate')).toMatch(/^Caro cliente,\n\n[^\r]+\{empresa\}$/);
  expect(value('smsPaymentOverdueTemplate')).toMatch(/^Caro cliente,/);
  expect(value('whatsappSuspensionTemplate')).toBe('Bom dia {nome}: deve {valor} há {dias_atraso}, corte em {dias_suspensao}.');
  expect(value('companyName')).toBe('Valor {valor} CVE');
});

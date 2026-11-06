import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { businessDay, businessMonth, businessYear, sqlBusinessDate, SQL_BUSINESS_TODAY } from './business-day';
import { todayStartUtc } from './date';
import { defaultPostpaidReferenceMonth } from './billing-period';

// 23:30 de 5/11 em Cabo Verde = 00:30 de 6/11 em UTC: o caso que partia o saldo do Stripe.
const LATE_EVENING = new Date('2026-11-06T00:30:00Z');

test('o dia, o mês e o ano são os de Cabo Verde (UTC−1)', () => {
  expect(businessDay(LATE_EVENING)).toBe('2026-11-05');
  expect(businessDay(new Date('2026-11-06T01:00:00Z'))).toBe('2026-11-06');
  expect(businessMonth(new Date('2026-12-01T00:59:59Z'))).toBe('2026-11');
  expect(businessYear(new Date('2027-01-01T00:30:00Z'))).toBe(2026);
  expect(businessDay(Date.parse('2026-11-06T00:30:00Z'))).toBe('2026-11-05');
});

test('a validação de datas futuras e o mês de competência seguem o mesmo dia', () => {
  expect(new Date(todayStartUtc(LATE_EVENING)).toISOString().slice(0, 10)).toBe('2026-11-05');
  // Dia 30 de faturação: às 23:30 de 30/11 em CV ainda é o próprio dia 30, não 1/12.
  expect(defaultPostpaidReferenceMonth(new Date('2026-12-01T00:30:00Z'), 30)).toBe('2026-11');
  expect(defaultPostpaidReferenceMonth(new Date('2027-01-15T12:00:00Z'), 30)).toBe('2026-12');
});

test('o SQL corta o dia no mesmo sítio que o JS', () => {
  const db = new Database(':memory:');
  const instant = "'2026-11-06 00:30:00'";
  const sqlAt = (sql: string) => (db.prepare(`SELECT ${sql.replace("'now'", instant)} AS d`).get() as { d: string }).d;
  expect(sqlAt(SQL_BUSINESS_TODAY)).toBe(businessDay(LATE_EVENING));
  expect(sqlAt(sqlBusinessDate("'+7 days'"))).toBe('2026-11-12');
  // E agora, no relógio real (repete uma vez se calhar na viragem do dia).
  const now = () => (db.prepare(`SELECT ${SQL_BUSINESS_TODAY} AS d`).get() as { d: string }).d;
  const first = now();
  expect(first === businessDay() || now() === businessDay()).toBe(true);
  db.close();
});

// Guarda: ninguém volta a cortar "hoje" em UTC. As exceções contam UTC de propósito.
const UTC_ON_PURPOSE = new Set([
  'src/backend/lib/wan-usage.ts', // a conta Starlink conta em UTC
  'src/backend/lib/network-discovery.ts', // retenção por instante, não por dia
  'src/backend/lib/router-config-backup.ts', // verificação diária técnica
  'src/backend/db/schema.ts', // DEFAULT da migração (não se mexe em DEFAULT, ver memória)
  'src/shared/business-day.ts',
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'migrations' ? [] : sources(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full.split(path.sep).join('/')] : [];
  });
}

test('nenhum "hoje" novo em UTC fora das exceções', () => {
  const offenders: string[] = [];
  for (const file of sources('src')) {
    if (UTC_ON_PURPOSE.has(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/date\('now'(?!, '-1 hours')/.test(line) || /new Date\(\)\.toISOString\(\)\.slice\(0, (10|7)\)/.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

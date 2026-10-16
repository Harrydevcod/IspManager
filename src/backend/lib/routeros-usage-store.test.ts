import { expect, test } from 'vitest';
import { wanUsageScript } from './routeros-wan-script';
import { clientUsageScript } from './routeros-client-script';

// 2026-10-13, hEX S: a corrida do arranque não via o sd1, criou o script de dados vazio e a
// seguinte passou-o por cima do ficheiro. Com disco previsto, o script de dados não nasce nos
// primeiros 10 minutos ligado.
test.each([['wan', wanUsageScript], ['client', clientUsageScript]])('%s: sem o disco logo após o arranque não grava estado no script', (_, script) => {
  const withDisk = script('sd1');
  expect(withDisk).toContain(':local diskWanted true');
  expect(withDisk).toMatch(/:if \(!\$diskWanted \|\| \(\[\/system resource get uptime\] >= \[:totime "00:10:00"\]\)\) do=\{\s*\/system script add /);
  // Sem disco, o script de dados é o único estado: grava-se sempre, como antes.
  expect(script(null)).toContain(':local diskWanted false');
});

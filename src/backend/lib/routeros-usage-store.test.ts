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

// 2026-11-02, hEX S: um corte de luz deixou o ficheiro das WAN sem o dia até ao corte nem o
// histórico. A cópia grava-se antes do principal, cada gravação fecha com `# fim`, e um ficheiro
// que não se lê pára a corrida antes de gravar.
test.each([['wan', wanUsageScript, 'ispm-wan-usage'], ['client', clientUsageScript, 'ispm-client-usage']])('%s: um corte a meio da gravação não leva o estado', (_, script, name) => {
  const text = script('sd1');
  expect(text).toContain(`:set backFile "sd1/${name}.bak.txt"`);
  expect(text).toContain(':set output ($output . "# fim\\n")');
  // A cópia primeiro, o principal depois.
  expect(text.indexOf('/file set $backFile')).toBeGreaterThan(0);
  expect(text.indexOf('/file set $backFile')).toBeLessThan(text.indexOf('/file set $dataFile'));
  // Principal cortado (sem `# fim`) cai na cópia; sem cópia é de uma versão anterior e lê-se.
  expect(text).toMatch(/:if \(\[:typeof \[:find \$main "# fim"\]\] != "nil"\) do=\{ :set text \$main \} else=\{\s*:if \(\[:typeof \[:find \$back "# fim"\]\] != "nil"\) do=\{ :set text \$back \} else=\{\s*:if \(!\$hasBack\) do=\{ :set text \$main \}/);
  // Ilegível: avisa e pára antes de chegar à gravação.
  expect(text.indexOf(':error "estado ilegivel"')).toBeLessThan(text.indexOf(':set output ($output . "# fim'));
});

// 2026-11-05, hEX S, reinício limpo já com a v9: logo após o arranque os ficheiros ainda não se
// liam, o estado saía vazio e a corrida gravava-o por cima dos dois. Estado vazio com o disco
// montado só passa como instalação nova: nunca com ficheiros lá, nunca nos primeiros 10 minutos.
test.each([['wan', wanUsageScript, 'ispm-wan-usage'], ['client', clientUsageScript, 'ispm-client-usage']])('%s: estado por ler logo após o arranque não grava por cima', (_, script, name) => {
  const text = script('sd1');
  const guard = text.indexOf(':if ([:len $text] = 0) do={');
  expect(guard).toBeGreaterThan(text.indexOf(':if (!$hasBack) do={ :set text $main }'));
  expect(guard).toBeLessThan(text.indexOf(':set output ($output . "# fim'));
  expect(text).toMatch(/:if \(\$hasMain \|\| \$hasBack\) do=\{\s*:log warning "[^"]+: estado no disco sem # fim, corrida sem gravar"\s*:error/);
  expect(text).toMatch(/:if \(\[\/system resource get uptime\] < \[:totime "00:10:00"\]\) do=\{\s*:log warning "[^"]+: estado ainda por ler no disco, corrida sem gravar"\s*:error/);
  expect(text).toContain(`:log warning "${name}: estado ainda por ler`);
  // Só no ramo do ficheiro: sem disco o estado é o script de dados e nada muda.
  expect(guard).toBeGreaterThan(text.indexOf(':if ([:len $dataFile] > 0) do={'));
});

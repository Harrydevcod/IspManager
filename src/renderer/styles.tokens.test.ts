import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Toda a `var(--x)` usada tem de existir.
 *
 * Uma variável CSS que não existe **não dá erro**: a declaração é descartada em
 * silêncio e a regra fica sem efeito. Um `gap: var(--s2)` com o nome errado não
 * pinta nada de vermelho — encolhe o espaçamento para zero e a página continua
 * a funcionar, só que apertada.
 *
 * Foi exatamente o que aconteceu: `--s1` a `--s5` nunca existiram (a escala
 * chama-se `--space-N`) e 26 espaçamentos da aba Descoberta estavam a colapsar,
 * sem ninguém dar por isso. Este teste é o que impede a próxima vez.
 */

const ROOT = __dirname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

/** Sempre com barras normais, para a lista abaixo não depender do sistema. */
function label(file: string, token: string): string {
  return `${path.relative(ROOT, file).split(path.sep).join('/')}: ${token}`;
}

function brokenTokens(): string[] {
  const files = cssFiles(ROOT);
  const defined = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
      defined.add(match[1]);
    }
  }

  const broken = new Set<string>();
  for (const file of files) {
    // `var(--x, alternativa)` sobrevive sem o token; sem alternativa, não.
    for (const match of readFileSync(file, 'utf8').matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
      if (!defined.has(match[1])) broken.add(label(file, match[1]));
    }
  }
  return [...broken];
}

/**
 * Estragos que já cá estavam.
 *
 * Encontrados no dia em que este teste nasceu. Não se corrigem aqui de
 * propósito: cada um faz reaparecer um espaçamento ou uma cor que está
 * colapsada há muito, e isso muda o aspeto de módulos que ninguém pediu para
 * mexer — sem olhar para cada ecrã, era trocar um defeito silencioso por outro.
 *
 * É uma catraca: não conserta o que está partido, impede partir mais. Corrigir
 * uma linha (e apagá-la daqui) é trabalho de quem for a esse módulo.
 */
const CONHECIDOS = new Set([
  'modules/clients/import/ClientImportDialog.css: --text-1',
  'modules/ExpensesModule.css: --surface-1',
  'modules/ExpensesModule.css: --text-1',
  'modules/InvestmentsModule.css: --surface-1',
  'modules/InvestmentsModule.css: --text-1',
  'modules/InvestmentsModule.css: --fs-md',
  'modules/PlansModule.css: --s4',
  'modules/PlansModule.css: --s3',
  'modules/PlansModule.css: --s2',
  'modules/topology/BackboneWorkspace.css: --warning',
  'modules/topology/BackboneWorkspace.css: --text-1',
  'modules/WorkOrdersModule.css: --fs-md',
  'modules/WorkOrdersModule.css: --text-1',
  'styles.css: --text-1',
  'styles.css: --s4',
  'styles.css: --fs-md'
]);

describe('tokens CSS', () => {
  test('nenhuma var(--x) nova aponta para um token que não existe', () => {
    expect(brokenTokens().filter((entry) => !CONHECIDOS.has(entry))).toEqual([]);
  });

  test('a catraca não guarda estragos que já foram corrigidos', () => {
    // Uma entrada obsoleta na lista esconde a próxima que aparecer no mesmo
    // ficheiro. Se isto falhar, apague a linha que sobra.
    const ainda = new Set(brokenTokens());
    expect([...CONHECIDOS].filter((entry) => !ainda.has(entry))).toEqual([]);
  });
});

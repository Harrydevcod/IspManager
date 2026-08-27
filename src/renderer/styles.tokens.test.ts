import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Toda a `var(--x)` usada tem de existir.
 *
 * Uma variável CSS que não existe **não dá erro**: a declaração é descartada em
 * silêncio e a regra fica sem efeito. Um `gap: var(--s2)` com o nome errado não
 * pinta nada de vermelho — encolhe o espaçamento para zero e a página continua
 * a funcionar, só que apertada. É o tipo de defeito que ninguém encontra a
 * olhar para o código e que ninguém reporta, porque nada falha.
 *
 * Foi assim que 43 declarações ficaram sem efeito na aplicação: `--s1` a `--s5`
 * (a escala chama-se `--space-N`), `--text-1` e `--surface-1` (as bases são
 * `--text` e `--surface`), `--warning` (é `--warn`) e `--fs-md` (é `--fs-base`).
 * Este teste é o que impede a próxima.
 */

const ROOT = __dirname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

describe('tokens CSS', () => {
  test('nenhuma var(--x) aponta para um token que não existe', () => {
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
        if (!defined.has(match[1])) {
          broken.add(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${match[1]}`);
        }
      }
    }

    expect([...broken]).toEqual([]);
  });
});

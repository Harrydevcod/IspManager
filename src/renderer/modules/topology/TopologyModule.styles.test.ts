import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sheets = {
  'TopologyModule.css': readFileSync(
    new URL('./TopologyModule.css', import.meta.url),
    'utf8'
  ),
  'TopologyCanvas.css': readFileSync(
    new URL('./TopologyCanvas.css', import.meta.url),
    'utf8'
  ),
  'TopologyInspector.css': readFileSync(
    new URL('./TopologyInspector.css', import.meta.url),
    'utf8'
  )
};

function declarations(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  return match?.[1] ?? '';
}

/**
 * Um comentário entre dois seletores não separa a lista: o CSS ignora-o e as
 * regras ficam fundidas. Foi assim que `.topology-filter-menu[open] summary`
 * herdou a animação de `.topology-refreshing` e os Filtros passaram a rodar
 * para sempre com o menu aberto. O erro não se vê a ler o ficheiro, por isso
 * fica aqui a catraca em vez de um teste àquela linha em concreto.
 */
function commentsInsideSelectorLists(css: string): string[] {
  const hits: string[] = [];
  const comments = /\/\*[\s\S]*?\*\//g;
  let match: RegExpExecArray | null;
  while ((match = comments.exec(css)) !== null) {
    // Os comentários já fechados antes deste não contam: a prosa lá dentro tem
    // vírgulas e daria falso positivo em cada bloco bem comentado.
    const before = css.slice(0, match.index).replace(/\/\*[\s\S]*?\*\//g, '');
    const blockBoundary = Math.max(
      before.lastIndexOf('{'),
      before.lastIndexOf('}'),
      before.lastIndexOf(';')
    );
    if (before.slice(blockBoundary + 1).includes(',')) {
      hits.push(match[0].split('\n')[0].slice(0, 60));
    }
  }
  return hits;
}

describe('folhas de estilo da topologia', () => {
  test.each(Object.keys(sheets))(
    '%s não parte uma lista de seletores com um comentário',
    (name) => {
      expect(commentsInsideSelectorLists(sheets[name as keyof typeof sheets]))
        .toEqual([]);
    }
  );

  test('o menu de filtros aberto lê-se como carregado, não a rodar', () => {
    const open = declarations(
      sheets['TopologyModule.css'],
      ".topology-filter-menu[open] summary"
    );
    expect(open).not.toMatch(/animation/);
    expect(open).toMatch(/background:/);
    expect(open).toMatch(/border-color:/);
  });

  test('a rotação fica só no estado de leitura em curso', () => {
    expect(declarations(sheets['TopologyModule.css'], '.topology-refreshing'))
      .toMatch(/animation:\s*topology-refresh-spin/);
  });
});

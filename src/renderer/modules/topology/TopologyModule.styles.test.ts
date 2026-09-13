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
  ),
  'BackboneWorkspace.css': readFileSync(
    new URL('./BackboneWorkspace.css', import.meta.url),
    'utf8'
  )
};

const names = Object.keys(sheets) as Array<keyof typeof sheets>;

/** Linhas com conteúdo, já sem comentários — para as varreduras de deriva. */
function statements(css: string): Array<{ line: number; text: string }> {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => entry.text.trim().length > 0);
}

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

  /*
   * A animação que provocou o bug deixou de existir: recarregar o mapa e abrir
   * um ramo usam a prop `loading` do `Button`, que já traz spinner e
   * `aria-busy`. Se alguém voltar a desenhá-la à mão, volta o problema.
   */
  test.each(names)('%s não redesenha o spinner que o Button já tem', (name) => {
    expect(sheets[name]).not.toMatch(/topology-(refresh-)?spin|topology-refreshing/);
  });
});

describe('o módulo fica dentro do sistema de design', () => {
  /* `^|[;{]` e não só `^`: uma regra escrita numa linha só
     (`.x { margin: 0.35rem; }`) escapava à varredura ancorada no início. */
  const SPACING = /(?:^|[;{])\s*((?:padding|margin)(?:-(?:inline|block|top|right|bottom|left)(?:-(?:start|end))?)?|(?:row-|column-)?gap)\s*:/;

  test.each(names)('%s mede o espaçamento pela escala, não a olho', (name) => {
    const offScale = statements(sheets[name])
      .filter((entry) => SPACING.test(entry.text) && /[\d.]rem/.test(entry.text))
      .map((entry) => `${name}:${entry.line} ${entry.text.trim()}`);
    expect(offScale).toEqual([]);
  });

  test.each(names)('%s não inventa tamanhos de letra', (name) => {
    const raw = statements(sheets[name])
      .filter((entry) => /font-size:\s*[\d.]+(rem|px|em)/.test(entry.text))
      .map((entry) => `${name}:${entry.line} ${entry.text.trim()}`);
    expect(raw).toEqual([]);
  });

  /*
   * Medido no codebase todo, não copiado da DESIGN.md: a app assenta em 500
   * (33 usos), 600 (94) e 700 (69). O "380 body" que a DESIGN.md anuncia
   * aparece duas vezes em toda a aplicação.
   */
  test.each(names)('%s usa os três degraus de peso que a app usa', (name) => {
    const weights = [...sheets[name].matchAll(/font-weight:\s*(\d+)/g)]
      .map((match) => Number(match[1]));
    expect(weights.filter((weight) => ![500, 600, 700].includes(weight)))
      .toEqual([]);
  });

  test.each(names)('%s não traz uma quarta curva de aceleração', (name) => {
    expect(sheets[name]).not.toMatch(/cubic-bezier/);
  });

  /*
   * Os valores pequenos (1, 2, 4, 8, 9, 20) são empilhamento local dentro do
   * canvas e ficam literais de propósito. O que não pode voltar é um número
   * solto na zona onde a shell empilha — `--z-sticky` é 40.
   */
  test.each(names)('%s não empilha à mão na zona do cromo da app', (name) => {
    const competing = statements(sheets[name])
      .filter((entry) => {
        const match = entry.text.match(/z-index:\s*(\d+)/);
        return match !== null && Number(match[1]) >= 40;
      })
      .map((entry) => `${name}:${entry.line} ${entry.text.trim()}`);
    expect(competing).toEqual([]);
  });
});

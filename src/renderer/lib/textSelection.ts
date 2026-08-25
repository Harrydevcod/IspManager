/**
 * Uma linha de lista é clicável e, ao mesmo tempo, conteúdo que se copia — o IP,
 * o NIF, o valor. Arrastar sobre o texto para o selecionar acaba num `click` no
 * mesmo elemento, e sem esta guarda o detalhe abria por cima da seleção que o
 * utilizador acabou de fazer.
 *
 * Só o rato passa por aqui: Enter e Espaço abrem a linha sempre, porque nunca
 * deixam seleção atrás de si.
 */
export function hasTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  // `isCollapsed` sozinho não chega: um clique simples deixa uma seleção vazia
  // mas não colapsada em alguns casos, e aí o texto é a única prova.
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim() !== '');
}

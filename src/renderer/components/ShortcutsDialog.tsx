import { Dialog } from './Dialog';

type Shortcut = { keys: string[]; description: string };

const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: 'Geral',
    items: [
      { keys: ['Ctrl', 'K'], description: 'Abrir a paleta de comandos' },
      { keys: ['?'], description: 'Mostrar esta lista de atalhos' },
      { keys: ['Esc'], description: 'Fechar diálogo, paleta ou painel' }
    ]
  },
  {
    group: 'Paleta de comandos',
    items: [
      { keys: ['↑', '↓'], description: 'Navegar entre resultados' },
      { keys: ['Enter'], description: 'Executar o comando selecionado' }
    ]
  },
  {
    group: 'Listas e tabelas',
    items: [
      { keys: ['Tab'], description: 'Percorrer campos e linhas por teclado' },
      { keys: ['Enter'], description: 'Abrir a linha em foco' },
      { keys: ['Espaço'], description: 'Selecionar/abrir o elemento em foco' }
    ]
  }
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} eyebrow="Ajuda" title="Atalhos de teclado" size="sm">
      <div className="shortcuts">
        {SHORTCUTS.map((section) => (
          <div className="shortcuts-group" key={section.group}>
            <h3 className="shortcuts-group-title">{section.group}</h3>
            <dl className="shortcuts-list">
              {section.items.map((shortcut) => (
                <div className="shortcuts-row" key={shortcut.description}>
                  <dt className="shortcuts-keys">
                    {shortcut.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd className="shortcuts-desc">{shortcut.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

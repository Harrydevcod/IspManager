import { useEffect, useState } from 'react';
import { Sparkles, WifiOff } from 'lucide-react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Skeleton } from './Skeleton';

type Block = { kind: 'heading' | 'item' | 'text'; text: string };
type NotesState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; blocks: Block[] };

/**
 * Markdown-lite das notas de release (títulos ##, bullets, **negrito**) para
 * blocos renderizáveis. O título "ISPM x.y.z" duplica o título do diálogo e o
 * rodapé 🤖 é ruído — ambos saem.
 */
function parseNotes(markdown: string): Block[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('🤖'))
    .map<Block>((line) => {
      if (/^#+\s/.test(line)) return { kind: 'heading', text: line.replace(/^#+\s*/, '') };
      if (/^[-*]\s/.test(line)) return { kind: 'item', text: line.replace(/^[-*]\s*/, '') };
      return { kind: 'text', text: line };
    })
    .filter((block) => !(block.kind === 'heading' && /^ISPM\s/i.test(block.text)));
}

/** **negrito** → <strong>; links e crases reduzidos a texto. */
function renderInline(text: string) {
  const clean = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '');
  return clean.split('**').map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part));
}

export function ReleaseNotesDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const [state, setState] = useState<NotesState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch(`https://api.github.com/repos/Harrydevcod/IspManager/releases/tags/v${version}`, {
      headers: { accept: 'application/vnd.github+json' }
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ body?: string }>) : Promise.reject(new Error(String(response.status)))))
      .then((data) => {
        if (cancelled) return;
        const blocks = data.body ? parseNotes(data.body) : [];
        setState(blocks.length > 0 ? { kind: 'ready', blocks } : { kind: 'error' });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Atualização"
      title={`Novidades do ISPM ${version}`}
      size="sm"
      actions={<Button onClick={onClose}>Fechar</Button>}
    >
      <div className="release-notes">
        {state.kind === 'loading' && (
          <>
            <Skeleton height={56} radius={10} />
            <Skeleton height={56} radius={10} />
          </>
        )}
        {state.kind === 'error' && (
          <p className="release-notes-empty">
            <WifiOff size={14} aria-hidden /> Não foi possível obter as notas desta versão. Verifica a ligação à internet.
          </p>
        )}
        {state.kind === 'ready' &&
          state.blocks.map((block, index) =>
            block.kind === 'heading' ? (
              <h3 key={index}>{renderInline(block.text)}</h3>
            ) : block.kind === 'item' ? (
              <p className="release-notes-item" key={index}>
                <Sparkles size={13} aria-hidden />
                <span>{renderInline(block.text)}</span>
              </p>
            ) : (
              <p key={index}>{renderInline(block.text)}</p>
            )
          )}
      </div>
    </Dialog>
  );
}

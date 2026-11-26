/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';

test('on mobile shows an informational state without contacting GitHub', async () => {
  vi.stubGlobal('fetch', vi.fn());
  const original = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, origin: 'https://appassets.androidplatform.net' } });
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<ReleaseNotesDialog version="2.76" onClose={() => {}} />));
    expect(fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('notas desta versão não estão disponíveis no telemóvel');
  } finally {
    await act(async () => root.unmount());
    node.remove();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    vi.unstubAllGlobals();
  }
});

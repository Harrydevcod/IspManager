import { useEffect, useState } from 'react';
import { authFetch } from './auth';

/**
 * Authenticated downloads & inline previews — without ever putting the auth
 * token in a URL.
 *
 * Plain `<a href>` navigation and `<iframe src>` do NOT carry the
 * `Authorization` header (only `authFetch` does), so guarded endpoints reject
 * them when auth is on. A token in the query string would "fix" that but leaks
 * into browser/Electron history and backend request logs. Instead we fetch the
 * bytes with `authFetch` (header intact), turn the response into a `blob:`
 * object URL, and feed that to the anchor/iframe. The object URL is same-origin
 * and opaque, so it works everywhere a normal URL would.
 */

export function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1] : null;
}

/** Fetches `url` with the auth header and triggers a file download client-side. */
export async function downloadAuthenticated(url: string, fallbackName: string): Promise<void> {
  const response = await authFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  // Na app empacotada a janela corre em file://, e um blob application/pdf é
  // capturado pelo visualizador de PDF embutido do Chromium (abre inline) em
  // vez de disparar o download → o will-download do main nunca grava o ficheiro.
  // Reetiquetar como octet-stream tira o blob das mãos do viewer; o atributo
  // `download` passa a ganhar e o will-download grava em Transferências. Só os
  // PDFs precisam disto (CSV/xlsx já descarregam bem).
  const downloadBlob = blob.type === 'application/pdf'
    ? blob.slice(0, blob.size, 'application/octet-stream')
    : blob;
  const objectUrl = URL.createObjectURL(downloadBlob);
  try {
    const filename = filenameFromContentDisposition(response.headers.get('content-disposition')) ?? fallbackName;
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}

/**
 * Loads an authenticated resource as a `blob:` object URL suitable for an
 * `<iframe src>`. Returns `null` while loading, sets `error` on failure, and
 * revokes the object URL on change/unmount to avoid leaks. Pass `url = null` to
 * stand the hook down (e.g. when no document is selected).
 */
export function useAuthenticatedObjectUrl(url: string | null): { objectUrl: string | null; error: boolean } {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setObjectUrl(null);
    setError(false);
    if (!url) return;

    let active = true;
    let created: string | null = null;
    authFetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (active) setError(true);
      });

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  return { objectUrl, error };
}

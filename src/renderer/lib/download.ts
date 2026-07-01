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

export type DownloadResult = { saved: boolean; path?: string; canceled?: boolean; error?: string; filename?: string };
export type PrintResult = { printed: boolean; canceled?: boolean; error?: string };

/**
 * Fetches `url` with the auth header and saves the bytes to disk.
 *
 * No Electron (preload presente) passa os bytes ao main, que abre o diálogo
 * nativo "Guardar como" com o nome correto e escreve o ficheiro — determinista,
 * com o utilizador a escolher o destino. Fora do Electron (web/sem preload) cai
 * no `blob:` + `<a download>` habitual.
 */
export async function downloadAuthenticated(url: string, fallbackName: string): Promise<DownloadResult> {
  const response = await authFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const filename = filenameFromContentDisposition(response.headers.get('content-disposition')) ?? fallbackName;

  const save = window.ispm?.saveDocument;
  if (save) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const result = await save(filename, data);
    if (!result.saved && !result.canceled) {
      throw new Error(result.error || 'Nao foi possivel guardar o ficheiro');
    }
    return { ...result, filename };
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
  return { saved: true, filename };
}

/** Fetches `url` with auth and prints it without exposing the token in a URL. */
export async function printAuthenticated(url: string): Promise<PrintResult> {
  const response = await authFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();

  const print = window.ispm?.printDocument;
  if (print) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const result = await print(data);
    if (!result.printed && !result.canceled) {
      throw new Error(result.error || 'Nao foi possivel imprimir o documento');
    }
    return result;
  }

  const objectUrl = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.src = objectUrl;
  document.body.appendChild(frame);

  await new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve();
    frame.onerror = () => reject(new Error('Nao foi possivel carregar o documento para impressao'));
  });
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(objectUrl);
  }, 10_000);
  return { printed: true };
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

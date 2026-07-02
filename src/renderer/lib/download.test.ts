import { beforeEach, describe, expect, test, vi } from 'vitest';
import { downloadAuthenticated, filenameFromContentDisposition, printAuthenticated } from './download';
import { authFetch } from './auth';

vi.mock('./auth', () => ({
  authFetch: vi.fn()
}));

const mockedAuthFetch = vi.mocked(authFetch);

describe('filenameFromContentDisposition', () => {
  test('prefers RFC 5987 filename when present', () => {
    expect(filenameFromContentDisposition(
      `attachment; filename="fallback.pdf"; filename*=UTF-8''Fatura%20-%20Ana%20Lima%20-%20FT-2026-00001.pdf`
    )).toBe('Fatura - Ana Lima - FT-2026-00001.pdf');
  });

  test('falls back to plain filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="relatorio.csv"')).toBe('relatorio.csv');
  });
});

describe('downloadAuthenticated', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('window', {
      ispm: {
        saveDocument: vi.fn()
      }
    });
  });

  test('passes the server filename and bytes to the Electron save bridge', async () => {
    const saveDocument = vi.fn().mockResolvedValue({ saved: true, path: 'C:\\Downloads\\Ana Lima.pdf' });
    vi.stubGlobal('window', { ispm: { saveDocument } });
    mockedAuthFetch.mockResolvedValue(new Response('PDF', {
      status: 200,
      headers: {
        'content-disposition': `attachment; filename="fallback.pdf"; filename*=UTF-8''Fatura%20-%20Ana%20Lima%20-%20FT-2026-00001.pdf`
      }
    }));

    await expect(downloadAuthenticated('/invoice.pdf', 'fallback.pdf')).resolves.toEqual({
      saved: true,
      path: 'C:\\Downloads\\Ana Lima.pdf',
      filename: 'Fatura - Ana Lima - FT-2026-00001.pdf'
    });

    expect(saveDocument).toHaveBeenCalledTimes(1);
    expect(saveDocument.mock.calls[0][0]).toBe('Fatura - Ana Lima - FT-2026-00001.pdf');
    expect(Array.from(saveDocument.mock.calls[0][1] as Uint8Array)).toEqual([80, 68, 70]);
  });

  test('throws when the Electron bridge fails without user cancellation', async () => {
    const saveDocument = vi.fn().mockResolvedValue({ saved: false, error: 'sem dados' });
    vi.stubGlobal('window', { ispm: { saveDocument } });
    mockedAuthFetch.mockResolvedValue(new Response('PDF', { status: 200 }));

    await expect(downloadAuthenticated('/invoice.pdf', 'fallback.pdf')).rejects.toThrow('sem dados');
  });
});

describe('printAuthenticated', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('window', {
      ispm: {
        printDocument: vi.fn()
      }
    });
  });

  test('passes the fetched PDF bytes to the Electron print bridge', async () => {
    const printDocument = vi.fn().mockResolvedValue({ printed: true });
    vi.stubGlobal('window', { ispm: { printDocument } });
    mockedAuthFetch.mockResolvedValue(new Response('PDF', { status: 200 }));

    await expect(printAuthenticated('/invoice.pdf')).resolves.toEqual({ printed: true });

    expect(printDocument).toHaveBeenCalledTimes(1);
    expect(Array.from(printDocument.mock.calls[0][0] as Uint8Array)).toEqual([80, 68, 70]);
  });
});

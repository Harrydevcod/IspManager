import { authFetch } from './auth';

const SETTINGS_API = 'http://127.0.0.1:3001/api/settings';

/**
 * A definição `printRentalLines` (detalhar o aluguer na fatura) vive nas
 * Configurações, mas também se liga na Tesouraria — é lá que se decide o que
 * sai nos documentos. Este módulo é o acesso curto a essa chave, para quem não
 * tem o formulário inteiro carregado.
 *
 * ponytail: lê e volta a gravar o objecto inteiro porque `PUT /api/settings`
 * valida o esquema completo e não aceita gravação parcial. Se um dia houver um
 * PATCH por chave, isto encolhe para uma chamada.
 */
export async function readPrintRentalLines(): Promise<boolean> {
  const response = await authFetch(SETTINGS_API);
  if (!response.ok) throw new Error('Nao foi possivel ler as configuracoes');
  const settings = await response.json() as { printRentalLines?: boolean };
  return settings.printRentalLines === true;
}

export async function writePrintRentalLines(value: boolean): Promise<void> {
  const current = await authFetch(SETTINGS_API);
  if (!current.ok) throw new Error('Nao foi possivel ler as configuracoes');
  const settings = await current.json() as Record<string, unknown>;
  // A senha do router vem mascarada; o servidor ignora a máscara ao gravar.
  const response = await authFetch(SETTINGS_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...settings, printRentalLines: value })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({ error: '' })) as { error?: string };
    throw new Error(result.error || 'Nao foi possivel gravar as configuracoes');
  }
}

import * as Sentry from '@sentry/electron/renderer';
import { DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from '../../shared/error-reports';

/**
 * Só arranca se o main arrancou (o preload diz-nos pelo argumento da janela).
 * O envio é do main, que volta a limpar cada evento; esta limpeza é a primeira.
 */
export const errorReportsActive = window.ispm?.errorReportsActive === true;

if (errorReportsActive) {
  Sentry.init({
    dataCollection: DATA_COLLECTION,
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSend: (event) => scrubEvent(event)
  });
}

/** Para os hooks de erro do React 19 no createRoot. Substituem o log por omissão do React, por isso registam na consola. */
export function reportReactError(error: unknown): void {
  console.error(error);
  if (errorReportsActive) Sentry.captureException(error);
}

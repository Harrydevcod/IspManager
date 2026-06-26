// Renderer formatting facade. Date and money helpers live in the shared layer
// so the backend and renderer share one implementation; re-exported here so
// renderer modules can keep importing everything from '../lib/format'.
export {
  formatPtDate,
  formatPtDateTime,
  formatPtDayMonth,
  formatPtMonth
} from '../../shared/date';

export {
  formatEscudos,
  formatCentavos,
  formatCompactEscudos,
  escudosToCentavos,
  centavosToEscudos
} from '../../shared/money';

import { formatEscudos } from '../../shared/money';

/**
 * Established renderer name for the money formatter. Renders an escudo amount
 * in the Cape Verde cifrão convention (`3.500$00`), so call sites must NOT
 * append a " CVE" suffix — the cifrão already carries the currency.
 */
export function formatCve(amountCve: number): string {
  return formatEscudos(amountCve);
}

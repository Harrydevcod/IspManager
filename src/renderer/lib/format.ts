// Renderer formatting facade. Date helpers live in the shared layer so the
// backend and renderer share one implementation; re-exported here so renderer
// modules can keep importing everything from '../lib/format'.
export {
  formatPtDate,
  formatPtDateTime,
  formatPtDayMonth,
  formatPtMonth
} from '../../shared/date';

export function formatCve(amountCve: number): string {
  return `${amountCve.toLocaleString('pt-PT')} CVE`;
}

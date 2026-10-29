import { LINK_MEDIUM_LABELS, type LinkMedium, type TopologyLinkProperties } from '../../../shared/topology';

/** Um rádio tem frequência; um cabo não. */
export function isRadio(medium: LinkMedium | null | undefined): boolean {
  return medium === 'ptp' || medium === 'ptmp';
}

/** "Rádio PtP · 5800 MHz · 450 Mbps · wlan1 → ether1": o que se sabe, pela ordem que interessa. */
export function linkSummary(link: TopologyLinkProperties | undefined): string | null {
  if (!link) return null;
  const ports = link.fromPort || link.toPort ? `${link.fromPort ?? '?'} → ${link.toPort ?? '?'}` : null;
  const parts = [
    link.medium ? LINK_MEDIUM_LABELS[link.medium] : null,
    isRadio(link.medium) && link.frequencyMhz ? `${link.frequencyMhz} MHz` : null,
    link.capacityMbps ? `${link.capacityMbps} Mbps` : null,
    ports
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** O traço diz o meio sem precisar de etiqueta: fibra grossa, rádio tracejado, PtMP em pontos. */
export function linkStroke(medium: LinkMedium | null | undefined): Record<string, string | number> {
  switch (medium) {
    case 'fibra': return { stroke: 'var(--accent)', strokeWidth: 3 };
    case 'ptp': return { stroke: 'var(--accent-2)', strokeWidth: 2, strokeDasharray: '8 5' };
    case 'ptmp': return { stroke: 'var(--accent-2)', strokeWidth: 2, strokeDasharray: '2 5', strokeLinecap: 'round' };
    case 'wan': return { stroke: 'var(--warn)', strokeWidth: 2 };
    default: return { stroke: 'var(--accent-2)', strokeWidth: 1.8 };
  }
}

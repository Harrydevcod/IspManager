import type { ReactNode } from 'react';

/**
 * Silhuetas próprias dos equipamentos — desenho nosso, sem fotos de fabricante.
 * Escolhe-se pelo tipo do catálogo, com a marca/modelo a desempatar o que o tipo
 * não diz (um Starlink é `antena` no catálogo, mas não é um painel).
 */
export type DeviceArtKind = 'router' | 'switch' | 'panel' | 'dish' | 'sector' | 'ap' | 'starlink' | 'box';

export function deviceArtKind(item: { type: string; brand?: string | null; model?: string | null }): DeviceArtKind {
  const type = item.type.trim().toLowerCase();
  const name = `${item.brand ?? ''} ${item.model ?? ''}`.toLowerCase();
  if (name.includes('starlink') && type !== 'router') return 'starlink';
  if (type === 'switch') return 'switch';
  if (type === 'router') return 'router';
  if (/prism|sector|setorial|rocket/.test(name)) return 'sector';
  if (/powerbeam|dish|prato|ptp/.test(name)) return 'dish';
  if (type === 'cpe' || type === 'antena') return 'panel';
  if (type === 'ap' || type === 'repetidor' || /access point|unifi|eap/.test(name)) return 'ap';
  return 'box';
}

const PATHS: Record<DeviceArtKind, ReactNode> = {
  router: (
    <>
      <rect x="6" y="24" width="36" height="12" rx="3" />
      <path d="M14 24 L11 10 M34 24 L37 10" />
      <circle cx="12" cy="30" r="1.2" fill="currentColor" />
      <circle cx="17" cy="30" r="1.2" fill="currentColor" />
      <path d="M26 30 h10" />
    </>
  ),
  switch: (
    <>
      <rect x="4" y="18" width="40" height="12" rx="2" />
      {[9, 15, 21, 27, 33, 39].map((x) => <rect key={x} x={x - 2} y="21" width="4" height="4" rx="0.6" />)}
    </>
  ),
  panel: (
    <>
      <rect x="15" y="6" width="18" height="30" rx="4" />
      <path d="M24 36 v6 M18 42 h12" />
      <circle cx="24" cy="13" r="1.2" fill="currentColor" />
    </>
  ),
  dish: (
    <>
      <ellipse cx="22" cy="22" rx="9" ry="15" />
      <path d="M22 22 L36 22 M31 22 v14 M25 42 h12" />
    </>
  ),
  sector: (
    <>
      <rect x="19" y="4" width="10" height="34" rx="5" />
      <path d="M24 38 v6 M18 44 h12 M12 14 q-4 7 0 14 M36 14 q4 7 0 14" />
    </>
  ),
  ap: (
    <>
      <circle cx="24" cy="26" r="13" />
      <circle cx="24" cy="26" r="2" fill="currentColor" />
      <path d="M17 12 q7 -5 14 0" />
    </>
  ),
  starlink: (
    <>
      <rect x="8" y="10" width="32" height="22" rx="3" transform="rotate(-12 24 21)" />
      <path d="M24 32 v8 M17 42 h14" />
    </>
  ),
  box: (
    <>
      <path d="M24 6 L40 14 V34 L24 42 L8 34 V14 Z" />
      <path d="M8 14 L24 22 L40 14 M24 22 V42" />
    </>
  )
};

export function DeviceArt({ kind, size = 40 }: { kind: DeviceArtKind; size?: number }) {
  return (
    <svg
      className="device-art"
      data-kind={kind}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[kind]}
    </svg>
  );
}

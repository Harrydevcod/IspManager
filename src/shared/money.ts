/**
 * Money in the ISPM is Cape Verdean escudos (CVE). The canonical notation uses
 * the cifrão "$" as the escudo/centavo separator: `3.500$00` = 3500 escudos,
 * `20$50` = 20 escudos and 50 centavos.
 *
 * The escudo subdivides into 100 centavos. To keep arithmetic exact — no
 * IEEE-754 drift in sums, VAT, proportional allocations or ROI — the unit for
 * storage and computation is the integer centavo; escudos are only a display
 * unit. This module ships the cifrão formatting plus the centavo toolkit. The
 * storage migration of the `*_cve REAL` columns to integer `*_centavos` lands
 * in a follow-up that builds on these helpers.
 *
 * Shared by renderer (UI) and backend (PDF documents) so there is one money
 * formatter, exactly like the date helpers in ./date.
 */

export type Centavos = number;
export type Escudos = number;

// ---------------------------------------------------------------- conversion

/** Escudos (possibly fractional) → integer centavos, rounded to the centavo. */
export function escudosToCentavos(escudos: Escudos): Centavos {
  return Math.round((escudos || 0) * 100);
}

/** Integer centavos → escudos (fractional). */
export function centavosToEscudos(centavos: Centavos): Escudos {
  return Math.trunc(centavos || 0) / 100;
}

// ----------------------------------------------------------- safe arithmetic
// Centavos are integers, so + and − are already exact; only × and ÷ need an
// explicit rounding step, and proportional splits need remainder handling.

/** Exact sum of integer centavo amounts. */
export function sumCentavos(values: Centavos[]): Centavos {
  return values.reduce((total, v) => total + Math.trunc(v || 0), 0);
}

/** Scales a centavo amount by a factor (e.g. a VAT rate), rounded to the centavo. */
export function multiplyCentavos(centavos: Centavos, factor: number): Centavos {
  return Math.round(Math.trunc(centavos || 0) * factor);
}

/**
 * Splits `total` across `weights` using the largest-remainder method so the
 * parts sum back to exactly `total` — no centavo is created or lost. Used for
 * proportional allocation (OPEX per client, expense rateio, …).
 *
 * Negative weights are clamped to 0. When no weight is usable (empty signal or
 * all ≤ 0) the split is even, with the leftover centavos going to the first
 * buckets. The result preserves the sign of `total`.
 */
export function allocateCentavos(total: Centavos, weights: number[]): Centavos[] {
  const n = weights.length;
  if (n === 0) return [];

  const t = Math.trunc(total || 0);
  const sign = t < 0 ? -1 : 1;
  const abs = Math.abs(t);

  const safe = weights.map((w) => (w > 0 ? w : 0));
  const weightSum = safe.reduce((s, w) => s + w, 0);
  const ideal = weightSum > 0
    ? safe.map((w) => (abs * w) / weightSum)
    : safe.map(() => abs / n);

  const floored = ideal.map((x) => Math.floor(x));
  let remainder = abs - floored.reduce((s, x) => s + x, 0);

  const byRemainder = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const parts = [...floored];
  for (let k = 0; k < byRemainder.length && remainder > 0; k += 1) {
    parts[byRemainder[k].i] += 1;
    remainder -= 1;
  }
  return parts.map((p) => sign * p);
}

// -------------------------------------------------------------- formatting
// Cape Verde cifrão convention: "." groups thousands, "$" separates escudos
// from centavos. Implemented by hand (not Intl) so the output is deterministic
// across platforms/locales.

function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Integer centavos → `1.500$00`. Negatives → `-1.500$00`. */
export function formatCentavos(centavos: Centavos): string {
  const rounded = Math.round(centavos || 0);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const escudos = Math.trunc(abs / 100);
  const cent = abs % 100;
  return `${sign}${groupThousands(String(escudos))}$${String(cent).padStart(2, '0')}`;
}

/** Escudos (possibly fractional) → `1.500$00`. */
export function formatEscudos(escudos: Escudos): string {
  return formatCentavos(escudosToCentavos(escudos));
}

/**
 * Compact escudo label for dense chart axes/tooltips: `1,5M$`, `12k$`, `500$`.
 * Drops centavos by design — visual density over document precision.
 */
export function formatCompactEscudos(escudos: Escudos): string {
  const value = Math.abs(escudos || 0);
  const sign = (escudos || 0) < 0 ? '-' : '';
  if (value >= 1_000_000) return `${sign}${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M$`;
  if (value >= 10_000) return `${sign}${Math.round(value / 1000)}k$`;
  if (value >= 1000) return `${sign}${(value / 1000).toFixed(1)}k$`;
  return `${sign}${Math.round(value)}$`;
}

// ------------------------------------------------------------------ balances
// The `*_cve REAL` columns still hold escudos, so any balance derived from a
// SUM() carries IEEE-754 drift: 50000 - (10000 + 15000 + 25000) can land on
// 7.3e-12 instead of 0. Rounding to the centavo before comparing is what keeps
// a fully settled invoice from staying open by a fraction nobody can pay.

/** Escudos rounded to the centavo — the precision money actually has. */
export function roundEscudos(escudos: Escudos): Escudos {
  return Math.round((escudos || 0) * 100) / 100;
}

/** True when the outstanding balance is settled (zero or below, to the centavo). */
export function isSettled(balanceEscudos: Escudos): boolean {
  return escudosToCentavos(balanceEscudos) <= 0;
}

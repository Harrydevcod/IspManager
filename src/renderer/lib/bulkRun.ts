export type BulkResult = { ok: number; failed: number };

/**
 * Corre uma operação por item, em série (evita martelar o backend SQLite/WhatsApp),
 * e conta sucessos/falhas em vez de abortar à primeira. Uma falha num item não
 * impede os restantes.
 */
export async function runBulk<T>(items: readonly T[], op: (item: T) => Promise<void>): Promise<BulkResult> {
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await op(item);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

/** Resumo legível de um BulkResult para toast. */
export function summarizeBulk(result: BulkResult, noun: string): string {
  if (result.failed === 0) return `${result.ok} ${noun} com sucesso.`;
  if (result.ok === 0) return `Falhou em ${result.failed} ${noun}.`;
  return `${result.ok} ${noun}; ${result.failed} falhou(aram).`;
}

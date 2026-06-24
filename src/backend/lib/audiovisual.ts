import type { Database as DatabaseType } from 'better-sqlite3';

/**
 * Configuração do produto "Distribuição de Conteúdos Audiovisuais".
 *
 * A denominação é deliberadamente neutra (não "IPTV") por opção fiscal/comercial.
 * Vive em `app_settings` como o resto da config da empresa; o preço efetivo de cada
 * contrato é fixado (snapshot) na linha do `services`, esta config dá só os defaults
 * e a denominação a imprimir nos documentos.
 */
export const AUDIOVISUAL_DEFAULT_LABEL = 'Distribuição de Conteúdos Audiovisuais';
export const AUDIOVISUAL_DEFAULT_MONTHLY_CVE = 500;
export const AUDIOVISUAL_DEFAULT_ANNUAL_CVE = 5000;

export type AudiovisualConfig = {
  enabled: boolean;
  label: string;
  monthlyCve: number;
  annualCve: number;
};

export function loadAudiovisualConfig(db: DatabaseType): AudiovisualConfig {
  const rows = db
    .prepare(
      `SELECT key, value FROM app_settings
       WHERE key IN ('audiovisualEnabled','audiovisualLabel','audiovisualMonthlyCve','audiovisualAnnualCve')`
    )
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const num = (value: string | undefined, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const rawLabel = (map.get('audiovisualLabel') || '').trim();
  return {
    enabled: map.get('audiovisualEnabled') === 'true' || map.get('audiovisualEnabled') === '1',
    label: rawLabel || AUDIOVISUAL_DEFAULT_LABEL,
    monthlyCve: num(map.get('audiovisualMonthlyCve'), AUDIOVISUAL_DEFAULT_MONTHLY_CVE),
    annualCve: num(map.get('audiovisualAnnualCve'), AUDIOVISUAL_DEFAULT_ANNUAL_CVE)
  };
}

/**
 * Chave de competência da anuidade audiovisual: `AV-<ano de início do ciclo>-<mês
 * de aniversário>`. Distinta do formato mensal (`YYYY-MM`) e estável por ciclo, o
 * que torna a geração idempotente via `UNIQUE(service_id, reference_month)`.
 */
export function audiovisualAnnualReference(cycleStartYear: number, anniversaryMonth0: number): string {
  return `AV-${cycleStartYear}-${String(anniversaryMonth0 + 1).padStart(2, '0')}`;
}

export function isAudiovisualAnnualReference(reference: string | null | undefined): boolean {
  return !!reference && reference.startsWith('AV-');
}

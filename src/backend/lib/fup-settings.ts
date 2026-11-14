import type Database from 'better-sqlite3';

/**
 * Configuração da política de uso justo (FUP). Vive em `fup_settings`, nunca no
 * código: os valores daqui são só o default de sistema, usado quando a linha
 * falta ou está vazia. Cada alteração grava o histórico na mesma transação.
 */

export type FupSettingType = 'NUMERO' | 'TEXTO' | 'HORA' | 'FUSO';

export type FupSettings = {
  plafond_predefinido_gb: number;
  dia_ciclo: string;
  acao_ao_limite: 'REDUZIR' | 'BLOQUEAR';
  horario_limitacao: 'JANELA' | 'JANELA_FDS' | 'DIA_INTEIRO';
  limiar_aviso_percent: number;
  limiar_limitacao_percent: number;
  percent_velocidade_pico: number;
  janela_pico_inicio: string;
  janela_pico_fim: string;
  fuso_horario: string;
  intervalo_recolha_minutos: number;
  canal_aviso: 'SMS' | 'WHATSAPP';
  mensagem_aviso: string;
  unidade_gb: 'DECIMAL' | 'BINARIO';
  pacote_operadora_gb: number;
  ligacoes_extra_pacote: number;
  limiar_pacote_percent: number;
};

export type FupSettingKey = keyof FupSettings;

type Definition = { type: FupSettingType; default: string; label: string; description: string };

export const FUP_SETTING_DEFINITIONS: Record<FupSettingKey, Definition> = {
  plafond_predefinido_gb: { type: 'NUMERO', default: '0', label: 'Plafond predefinido (GB)', description: 'Consumo de referência dos planos que não definem o seu. 0 = sem plafond.' },
  dia_ciclo: { type: 'TEXTO', default: 'ATIVACAO', label: 'Dia de renovação', description: 'Dia em que o consumo volta a zero. O serviço pode ter o seu.' },
  acao_ao_limite: { type: 'TEXTO', default: 'REDUZIR', label: 'Ação ao atingir o limite', description: 'Reduzir a velocidade na janela de pico, ou bloquear a ligação o dia inteiro até ao ciclo seguinte.' },
  horario_limitacao: { type: 'TEXTO', default: 'JANELA', label: 'Horário da limitação', description: 'Quando a velocidade reduzida se aplica: só na janela de pico, na janela e ao fim de semana o dia inteiro, ou o dia inteiro até ao ciclo seguinte.' },
  limiar_aviso_percent: { type: 'NUMERO', default: '80', label: 'Limiar de aviso (%)', description: 'Percentagem do consumo de referência a partir da qual o cliente recebe o aviso, uma vez por ciclo.' },
  limiar_limitacao_percent: { type: 'NUMERO', default: '100', label: 'Limiar de limitação (%)', description: 'Percentagem a partir da qual a velocidade é reduzida na janela de pico, até ao ciclo seguinte.' },
  percent_velocidade_pico: { type: 'NUMERO', default: '50', label: 'Velocidade no pico (%)', description: 'Velocidade de um cliente limitado na janela de pico, em % da contratada. O plano pode ter a sua.' },
  janela_pico_inicio: { type: 'HORA', default: '18:00', label: 'Início da janela de pico', description: 'Hora a partir da qual a limitação se aplica. É o router que liga e desliga a janela, mesmo com o ISPM fechado.' },
  janela_pico_fim: { type: 'HORA', default: '00:00', label: 'Fim da janela de pico', description: 'Hora a partir da qual a velocidade contratada é reposta. 00:00 termina a janela à meia-noite.' },
  fuso_horario: { type: 'FUSO', default: 'Atlantic/Cape_Verde', label: 'Fuso horário', description: 'Fuso (IANA) da janela de pico. O router aplica a janela pelo seu próprio relógio: tem de estar no mesmo fuso.' },
  intervalo_recolha_minutos: { type: 'NUMERO', default: '5', label: 'Intervalo de recolha (min)', description: 'De quantos em quantos minutos o ISPM lê o consumo no router.' },
  canal_aviso: { type: 'TEXTO', default: 'WHATSAPP', label: 'Canal do aviso', description: 'Por onde sai o aviso: WhatsApp ou SMS. O cliente que recusou avisos não recebe nenhum.' },
  mensagem_aviso: { type: 'TEXTO', default: 'Caro cliente {nome}, já usou {percent}% do consumo de referência do seu plano ({gb} de {referencia} GB) neste ciclo. Ao chegar aos 100%, {acao} até ao próximo ciclo.', label: 'Mensagem de aviso', description: 'Texto do aviso. Campos: {nome} {percent} {gb} {referencia} {inicio} {fim} {pico} {acao}.' },
  unidade_gb: { type: 'TEXTO', default: 'DECIMAL', label: 'Unidade de consumo', description: 'Como se contam os GB do plafond, dos avisos e da tabela de consumo: decimais (1000³ bytes, como o Starlink) ou binários (1024³ bytes).' },
  pacote_operadora_gb: { type: 'NUMERO', default: '0', label: 'Pacote da operadora (GB)', description: 'GB do link por ciclo da conta. Acima de 0, cada cliente tem uma quota igual do pacote, em vez do plafond do plano. 0 = desligado.' },
  ligacoes_extra_pacote: { type: 'NUMERO', default: '1', label: 'Ligações sem ficha', description: 'Casa do dono e internet de graça que entram na divisão do pacote.' },
  limiar_pacote_percent: { type: 'NUMERO', default: '90', label: 'Limitar todos a partir de (%)', description: 'Percentagem do pacote da operadora a partir da qual todos os clientes ficam limitados até o pacote renovar.' }
};

export const FUP_SETTING_KEYS = Object.keys(FUP_SETTING_DEFINITIONS) as FupSettingKey[];

const NUMERIC = new Set<FupSettingKey>(['pacote_operadora_gb', 'ligacoes_extra_pacote', 'limiar_pacote_percent', 'plafond_predefinido_gb', 'limiar_aviso_percent', 'limiar_limitacao_percent', 'percent_velocidade_pico', 'intervalo_recolha_minutos']);

export class FupSettingsError extends Error {
  constructor(public readonly errors: Partial<Record<FupSettingKey, string>>) {
    super(Object.values(errors).join(' '));
  }
}

function parse(raw: Record<FupSettingKey, string>): FupSettings {
  const out = {} as Record<FupSettingKey, string | number>;
  for (const key of FUP_SETTING_KEYS) out[key] = NUMERIC.has(key) ? Number(raw[key]) : raw[key];
  return out as unknown as FupSettings;
}

function rawDefaults(): Record<FupSettingKey, string> {
  return Object.fromEntries(FUP_SETTING_KEYS.map((key) => [key, FUP_SETTING_DEFINITIONS[key].default])) as Record<FupSettingKey, string>;
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Valida o conjunto inteiro: as regras cruzadas (aviso < limitação, início < fim) só se veem juntas. */
export function validateFupSettings(raw: Record<FupSettingKey, string>): Partial<Record<FupSettingKey, string>> {
  const errors: Partial<Record<FupSettingKey, string>> = {};
  const percent = (key: FupSettingKey) => {
    const value = raw[key].trim();
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) errors[key] = 'Tem de ser um número inteiro entre 1 e 200.';
  };
  percent('limiar_aviso_percent');
  percent('limiar_limitacao_percent');
  percent('percent_velocidade_pico');
  if (!errors.limiar_aviso_percent && !errors.limiar_limitacao_percent
    && Number(raw.limiar_aviso_percent) >= Number(raw.limiar_limitacao_percent)) {
    // Regra entre dois campos: assinala os dois, seja qual for o que se mexeu.
    errors.limiar_aviso_percent = errors.limiar_limitacao_percent = 'O limiar de aviso tem de ser menor que o de limitação.';
  }
  for (const key of ['janela_pico_inicio', 'janela_pico_fim'] as const) {
    if (!HHMM.test(raw[key])) errors[key] = 'Hora no formato HH:MM.';
  }
  if (!errors.janela_pico_inicio && !errors.janela_pico_fim && (raw.janela_pico_inicio === raw.janela_pico_fim || (raw.janela_pico_fim !== '00:00' && minutesOf(raw.janela_pico_inicio) >= minutesOf(raw.janela_pico_fim)))) {
    errors.janela_pico_inicio = errors.janela_pico_fim = 'O início da janela tem de ser anterior ao fim.';
  }
  if (!isValidTimeZone(raw.fuso_horario)) errors.fuso_horario = 'Fuso horário IANA inválido (ex.: Atlantic/Cape_Verde).';
  const interval = raw.intervalo_recolha_minutos.trim();
  if (!/^\d+$/.test(interval) || Number(interval) < 1 || Number(interval) > 60) errors.intervalo_recolha_minutos = 'Tem de ser um número inteiro de 1 a 60.';
  if (raw.canal_aviso === 'EMAIL') errors.canal_aviso = 'Sem envio de email configurado: escolha WHATSAPP ou SMS.';
  else if (raw.canal_aviso !== 'SMS' && raw.canal_aviso !== 'WHATSAPP') errors.canal_aviso = 'Canal inválido: WHATSAPP ou SMS.';
  const plafond = raw.plafond_predefinido_gb.trim();
  if (!/^\d+$/.test(plafond) || Number(plafond) > 100_000) errors.plafond_predefinido_gb = 'Tem de ser um número inteiro de 0 a 100 000.';
  if (raw.dia_ciclo !== 'ATIVACAO' && !(/^\d{1,2}$/.test(raw.dia_ciclo) && Number(raw.dia_ciclo) >= 1 && Number(raw.dia_ciclo) <= 28)) errors.dia_ciclo = 'Dia de 1 a 28, ou o da ativação.';
  if (raw.acao_ao_limite !== 'REDUZIR' && raw.acao_ao_limite !== 'BLOQUEAR') errors.acao_ao_limite = 'Ação inválida: REDUZIR ou BLOQUEAR.';
  const pool = raw.pacote_operadora_gb.trim();
  if (!/^\d+$/.test(pool) || Number(pool) > 1_000_000) errors.pacote_operadora_gb = 'Tem de ser um número inteiro de 0 a 1 000 000.';
  const extra = raw.ligacoes_extra_pacote.trim();
  if (!/^\d+$/.test(extra) || Number(extra) > 100) errors.ligacoes_extra_pacote = 'Tem de ser um número inteiro de 0 a 100.';
  const poolPercent = raw.limiar_pacote_percent.trim();
  if (!/^\d+$/.test(poolPercent) || Number(poolPercent) < 1 || Number(poolPercent) > 100) errors.limiar_pacote_percent = 'Tem de ser um número inteiro de 1 a 100.';
  if (!['JANELA', 'JANELA_FDS', 'DIA_INTEIRO'].includes(raw.horario_limitacao)) errors.horario_limitacao = 'Horário inválido: JANELA, JANELA_FDS ou DIA_INTEIRO.';
  if (raw.unidade_gb !== 'DECIMAL' && raw.unidade_gb !== 'BINARIO') errors.unidade_gb = 'Unidade inválida: DECIMAL ou BINARIO.';
  if (!raw.mensagem_aviso.trim()) errors.mensagem_aviso = 'A mensagem não pode ficar vazia.';
  else if (raw.mensagem_aviso.length > 1000) errors.mensagem_aviso = 'A mensagem passa dos 1000 caracteres.';
  // Bloqueado não tem janela: uma mensagem que a cite mentia ao cliente.
  else if (raw.acao_ao_limite === 'BLOQUEAR' && /\{(inicio|fim|pico)\}/.test(raw.mensagem_aviso)) {
    errors.mensagem_aviso = 'Com a ligação bloqueada não há janela de pico: use {acao} em vez de {inicio}, {fim} e {pico}.';
  } else if (raw.horario_limitacao === 'DIA_INTEIRO' && /\{(inicio|fim)\}/.test(raw.mensagem_aviso)) {
    errors.mensagem_aviso = 'Com a limitação o dia inteiro não há janela de pico: use {acao} em vez de {inicio} e {fim}.';
  }
  return errors;
}

// ponytail: cache por base num WeakMap; um processo, uma base em produção.
const cache = new WeakMap<Database.Database, { raw: Record<FupSettingKey, string>; settings: FupSettings }>();

function readRaw(db: Database.Database): Record<FupSettingKey, string> {
  const raw = rawDefaults();
  const rows = db.prepare('SELECT key, value FROM fup_settings').all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    // Linha vazia = cai no default de sistema (a precedência da especificação).
    if (row.key in raw && row.value.trim() !== '') raw[row.key as FupSettingKey] = row.value;
  }
  return raw;
}

export function readFupSettingsRaw(db: Database.Database): Record<FupSettingKey, string> {
  const hit = cache.get(db);
  if (hit) return { ...hit.raw };
  const raw = readRaw(db);
  // Uma base com valores inválidos (escrita à mão) não deve partir o motor: cai no default.
  const errors = validateFupSettings(raw);
  for (const key of Object.keys(errors) as FupSettingKey[]) raw[key] = FUP_SETTING_DEFINITIONS[key].default;
  cache.set(db, { raw, settings: parse(raw) });
  return { ...raw };
}

export function readFupSettings(db: Database.Database): FupSettings {
  readFupSettingsRaw(db);
  return { ...cache.get(db)!.settings };
}

export function invalidateFupSettingsCache(db: Database.Database): void {
  cache.delete(db);
}

/** Precedência: o plano, se o definir; senão a global (que já caiu no default se vazia). */
export function effectivePeakPercent(plan: { fupPeakPercent: number | null }, settings: Pick<FupSettings, 'percent_velocidade_pico'>): number {
  return plan.fupPeakPercent ?? settings.percent_velocidade_pico;
}

/**
 * Plafond do serviço. Precedência: o do serviço (0 = isento), senão o do plano
 * se for maior que 0, senão o predefinido das Definições.
 */
export function effectiveReferenceGb(serviceGb: number | null, planGb: number | null, settings: Pick<FupSettings, 'plafond_predefinido_gb'>): number {
  if (serviceGb !== null) return serviceGb;
  if (planGb !== null && planGb > 0) return planGb;
  return settings.plafond_predefinido_gb;
}

/** Bytes de 1 GB na unidade escolhida: decimal (10⁹) ou binária (1024³). */
export function bytesPerGb(settings: Pick<FupSettings, 'unidade_gb'>): number {
  return settings.unidade_gb === 'BINARIO' ? 1024 ** 3 : 1e9;
}

/** Dia global de início do ciclo; nulo = o da ativação. */
export function globalCycleDay(settings: Pick<FupSettings, 'dia_ciclo'>): number | null {
  return settings.dia_ciclo === 'ATIVACAO' ? null : Number(settings.dia_ciclo);
}

/** O que acontece aos 100%, para o campo {acao} da mensagem. */
export function fupActionText(settings: Pick<FupSettings, 'acao_ao_limite' | 'horario_limitacao' | 'janela_pico_inicio' | 'janela_pico_fim'>, peakPercent: number): string {
  if (settings.acao_ao_limite === 'BLOQUEAR') return 'a ligação fica bloqueada';
  const window = `entre as ${settings.janela_pico_inicio} e as ${settings.janela_pico_fim}`;
  if (settings.horario_limitacao === 'DIA_INTEIRO') return `a velocidade passa a ${peakPercent}% da contratada`;
  if (settings.horario_limitacao === 'JANELA_FDS') return `a velocidade ${window}, e o dia inteiro ao sábado e ao domingo, passa a ${peakPercent}% da contratada`;
  return `a velocidade ${window} passa a ${peakPercent}% da contratada`;
}

export function candidateFupSettings(db: Database.Database, changes: Partial<Record<string, unknown>>): { raw: Record<FupSettingKey, string>; errors: Partial<Record<FupSettingKey, string>> } {
  const raw = readFupSettingsRaw(db);
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in FUP_SETTING_DEFINITIONS)) throw new FupSettingsError({ [key]: `Chave desconhecida: ${key}.` } as Partial<Record<FupSettingKey, string>>);
    raw[key as FupSettingKey] = String(value ?? '').trim();
  }
  return { raw, errors: validateFupSettings(raw) };
}

/**
 * Grava as chaves que mudaram e o histórico de cada uma numa só transação.
 * Nada se grava se uma chave falhar a validação.
 */
export function saveFupSettings(
  db: Database.Database,
  changes: Partial<Record<string, unknown>>,
  user: string,
  reason?: string | null
): { changed: FupSettingKey[] } {
  const before = readFupSettingsRaw(db);
  const { raw, errors } = candidateFupSettings(db, changes);
  if (Object.keys(errors).length > 0) throw new FupSettingsError(errors);
  const changed = FUP_SETTING_KEYS.filter((key) => raw[key] !== before[key]);
  const upsert = db.prepare(`INSERT INTO fup_settings (key, value, type, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const history = db.prepare('INSERT INTO fup_settings_history (key, old_value, new_value, changed_by, reason) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const key of changed) {
      upsert.run(key, raw[key], FUP_SETTING_DEFINITIONS[key].type, user);
      history.run(key, before[key], raw[key], user, reason?.trim() || null);
    }
  })();
  invalidateFupSettingsCache(db);
  return { changed };
}

export function resetFupSetting(db: Database.Database, key: string, user: string, reason?: string | null) {
  if (!(key in FUP_SETTING_DEFINITIONS)) throw new FupSettingsError({ [key]: `Chave desconhecida: ${key}.` } as Partial<Record<FupSettingKey, string>>);
  return saveFupSettings(db, { [key]: FUP_SETTING_DEFINITIONS[key as FupSettingKey].default }, user, reason ?? 'Reposto o default');
}

export function describeFupSettings(db: Database.Database) {
  const raw = readFupSettingsRaw(db);
  const meta = new Map((db.prepare('SELECT key, updated_at AS updatedAt, updated_by AS updatedBy FROM fup_settings').all() as Array<{ key: string; updatedAt: string | null; updatedBy: string | null }>)
    .map((row) => [row.key, row]));
  return FUP_SETTING_KEYS.map((key) => ({
    key,
    ...FUP_SETTING_DEFINITIONS[key],
    value: raw[key],
    updatedAt: meta.get(key)?.updatedAt ?? null,
    updatedBy: meta.get(key)?.updatedBy ?? null
  }));
}

export function listFupSettingsHistory(db: Database.Database, filter: { key?: string; from?: string; to?: string }) {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.key) { where.push('key = ?'); params.push(filter.key); }
  if (filter.from) { where.push('date(changed_at) >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('date(changed_at) <= ?'); params.push(filter.to); }
  return db.prepare(`SELECT id, key, old_value AS oldValue, new_value AS newValue, changed_by AS changedBy, changed_at AS changedAt, reason
    FROM fup_settings_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`).all(...params) as Array<{
    id: number; key: string; oldValue: string | null; newValue: string; changedBy: string; changedAt: string; reason: string | null;
  }>;
}

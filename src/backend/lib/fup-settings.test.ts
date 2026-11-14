import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import midnightMigration from '../db/migrations/0098_fup_meia_noite';
import {
  FUP_SETTING_DEFINITIONS, FUP_SETTING_KEYS, FupSettingsError, effectivePeakPercent, effectiveReferenceGb, fupActionText, globalCycleDay, invalidateFupSettingsCache, listFupSettingsHistory,
  readFupSettings, resetFupSetting, saveFupSettings, validateFupSettings, type FupSettingKey
} from './fup-settings';

let db: Database.Database;
let dataDir: string;
let closeDatabaseForTests: () => void;

const defaults = () => Object.fromEntries(FUP_SETTING_KEYS.map((k) => [k, FUP_SETTING_DEFINITIONS[k].default])) as Record<FupSettingKey, string>;
const errorsFor = (changes: Partial<Record<FupSettingKey, string>>) => validateFupSettings({ ...defaults(), ...changes });
// O histórico não se apaga; o teste conta a partir de onde já estava.
const historyCount = () => (db.prepare('SELECT COUNT(*) AS n FROM fup_settings_history').get() as { n: number }).n;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'ispm-fup-settings-test-'));
  process.env.ISPM_DATA_DIR = dataDir;
  const database = await import('../db/database');
  database.getDatabase();
  db = database.getSqliteDatabase();
  closeDatabaseForTests = database.closeDatabaseForTests;
});

beforeEach(() => {
  for (const key of FUP_SETTING_KEYS) db.prepare('UPDATE fup_settings SET value = ? WHERE key = ?').run(FUP_SETTING_DEFINITIONS[key].default, key);
  invalidateFupSettingsCache(db);
});

afterAll(() => {
  closeDatabaseForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
});

describe('validação', () => {
  test('defaults válidos', () => {
    expect(errorsFor({})).toEqual({});
    expect(FUP_SETTING_DEFINITIONS.janela_pico_fim.default).toBe('00:00');
    expect(errorsFor({ janela_pico_inicio: '18:00', janela_pico_fim: '00:00' })).toEqual({});
  });

  test.each([
    ['limiar_aviso_percent', '0'], ['limiar_aviso_percent', '201'], ['limiar_aviso_percent', '8.5'],
    ['limiar_limitacao_percent', 'abc'], ['percent_velocidade_pico', '0'], ['percent_velocidade_pico', '250'],
    ['janela_pico_inicio', '25:00'], ['janela_pico_fim', '7h'], ['fuso_horario', 'Mars/Olympus'], ['fuso_horario', ''],
    ['intervalo_recolha_minutos', '0'], ['intervalo_recolha_minutos', '61'], ['canal_aviso', 'EMAIL'], ['canal_aviso', 'FAX'],
    ['mensagem_aviso', '  ']
  ] as Array<[FupSettingKey, string]>)('%s = %j é recusado', (key, value) => {
    expect(errorsFor({ [key]: value })[key]).toBeTruthy();
  });

  test('regras cruzadas: aviso < limitação e início < fim', () => {
    expect(errorsFor({ limiar_aviso_percent: '100', limiar_limitacao_percent: '100' }).limiar_aviso_percent).toMatch(/menor/);
    expect(errorsFor({ janela_pico_inicio: '23:00', janela_pico_fim: '18:00' }).janela_pico_inicio).toMatch(/anterior/);
    expect(errorsFor({ limiar_aviso_percent: '150', limiar_limitacao_percent: '200', canal_aviso: 'SMS', fuso_horario: 'Europe/Lisbon' })).toEqual({});
  });
});

describe('plafond, renovação e ação', () => {
  test('validação das chaves novas', () => {
    expect(errorsFor({ plafond_predefinido_gb: '-1' }).plafond_predefinido_gb).toBeDefined();
    expect(errorsFor({ plafond_predefinido_gb: '100001' }).plafond_predefinido_gb).toBeDefined();
    expect(errorsFor({ plafond_predefinido_gb: '250' })).toEqual({});
    expect(errorsFor({ dia_ciclo: '0' }).dia_ciclo).toBeDefined();
    expect(errorsFor({ dia_ciclo: '29' }).dia_ciclo).toBeDefined();
    expect(errorsFor({ dia_ciclo: '28' })).toEqual({});
    expect(errorsFor({ acao_ao_limite: 'DESLIGAR' }).acao_ao_limite).toBeDefined();
    expect(errorsFor({ acao_ao_limite: 'BLOQUEAR' })).toEqual({});
    expect(errorsFor({ acao_ao_limite: 'BLOQUEAR', mensagem_aviso: 'Entre as {inicio} e as {fim}.' }).mensagem_aviso).toMatch(/\{acao\}/);
  });

  test('precedência do plafond e texto da ação', () => {
    const settings = { plafond_predefinido_gb: 250 };
    expect(effectiveReferenceGb(null, 0, settings)).toBe(250);
    expect(effectiveReferenceGb(null, null, settings)).toBe(250);
    expect(effectiveReferenceGb(null, 300, settings)).toBe(300);
    expect(effectiveReferenceGb(500, 300, settings)).toBe(500);
    expect(effectiveReferenceGb(0, 300, settings)).toBe(0);
    expect(globalCycleDay({ dia_ciclo: 'ATIVACAO' })).toBeNull();
    expect(globalCycleDay({ dia_ciclo: '15' })).toBe(15);
    const window = { janela_pico_inicio: '18:00', janela_pico_fim: '00:00', horario_limitacao: 'JANELA' as const };
    expect(fupActionText({ ...window, acao_ao_limite: 'REDUZIR' }, 50)).toBe('a velocidade entre as 18:00 e as 00:00 passa a 50% da contratada');
    expect(fupActionText({ ...window, acao_ao_limite: 'BLOQUEAR' }, 50)).toBe('a ligação fica bloqueada');
  });
});

describe('precedência', () => {
  test('plano > global > default de sistema', () => {
    expect(effectivePeakPercent({ fupPeakPercent: 30 }, { percent_velocidade_pico: 50 })).toBe(30);
    expect(effectivePeakPercent({ fupPeakPercent: null }, { percent_velocidade_pico: 60 })).toBe(60);
    db.prepare("UPDATE fup_settings SET value = '' WHERE key = 'percent_velocidade_pico'").run();
    invalidateFupSettingsCache(db);
    expect(readFupSettings(db).percent_velocidade_pico).toBe(50);
  });
});

describe('gravação', () => {
  test('migração estende o horário original e preserva os horários personalizados', () => {
    const fixture = new Database(':memory:');
    fixture.exec('CREATE TABLE fup_settings (key TEXT, value TEXT, updated_at TEXT); CREATE TABLE fup_settings_history (key TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, reason TEXT);');
    fixture.prepare('INSERT INTO fup_settings VALUES (?, ?, ?)').run('janela_pico_fim', '23:00', null);
    fixture.exec(midnightMigration.sql);
    expect(fixture.prepare('SELECT value FROM fup_settings').get()).toEqual({ value: '00:00' });
    expect(fixture.prepare('SELECT old_value, new_value FROM fup_settings_history').get()).toEqual({ old_value: '23:00', new_value: '00:00' });
    fixture.prepare('UPDATE fup_settings SET value = ?, updated_at = ?').run('23:00', '2026-01-01');
    fixture.exec(midnightMigration.sql);
    expect(fixture.prepare('SELECT value FROM fup_settings').get()).toEqual({ value: '23:00' });
    fixture.prepare('UPDATE fup_settings SET value = ?, updated_at = ?').run('22:00', '2026-01-01');
    fixture.exec(midnightMigration.sql);
    expect(fixture.prepare('SELECT value FROM fup_settings').get()).toEqual({ value: '22:00' });
    fixture.close();
  });
  test('cada alteração grava o histórico e invalida a cache', () => {
    const before = historyCount();
    expect(readFupSettings(db).limiar_aviso_percent).toBe(80);
    saveFupSettings(db, { limiar_aviso_percent: '70', janela_pico_fim: '22:30' }, 'admin', 'teste');
    expect(readFupSettings(db)).toMatchObject({ limiar_aviso_percent: 70, janela_pico_fim: '22:30' });
    expect(historyCount()).toBe(before + 2);
    const last = listFupSettingsHistory(db, { key: 'limiar_aviso_percent' })[0];
    expect(last).toMatchObject({ oldValue: '80', newValue: '70', changedBy: 'admin', reason: 'teste' });
    const row = db.prepare("SELECT updated_by AS by, updated_at AS at FROM fup_settings WHERE key = 'limiar_aviso_percent'").get() as { by: string; at: string };
    expect(row.by).toBe('admin');
    expect(row.at).toBeTruthy();
  });

  test('valor igual não grava histórico', () => {
    const before = historyCount();
    expect(saveFupSettings(db, { limiar_aviso_percent: '80' }, 'admin').changed).toEqual([]);
    expect(historyCount()).toBe(before);
  });

  test('uma chave inválida não deixa gravar nenhuma', () => {
    const before = historyCount();
    expect(() => saveFupSettings(db, { limiar_aviso_percent: '70', fuso_horario: 'Nope/Nope' }, 'admin')).toThrow(FupSettingsError);
    expect(readFupSettings(db).limiar_aviso_percent).toBe(80);
    expect(historyCount()).toBe(before);
  });

  test('chave desconhecida é recusada', () => {
    expect(() => saveFupSettings(db, { outra: '1' }, 'admin')).toThrow(FupSettingsError);
  });

  test('repor default grava no histórico', () => {
    saveFupSettings(db, { percent_velocidade_pico: '30' }, 'admin');
    resetFupSetting(db, 'percent_velocidade_pico', 'admin');
    expect(readFupSettings(db).percent_velocidade_pico).toBe(50);
    expect(listFupSettingsHistory(db, { key: 'percent_velocidade_pico' })[0]).toMatchObject({ oldValue: '30', newValue: '50', reason: 'Reposto o default' });
  });

  test('o histórico não se apaga nem se altera', () => {
    saveFupSettings(db, { percent_velocidade_pico: '30' }, 'admin');
    expect(() => db.prepare('DELETE FROM fup_settings_history').run()).toThrow(/não se apaga/);
    expect(() => db.prepare("UPDATE fup_settings_history SET new_value = 'x'").run()).toThrow(/não se altera/);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  FUP_SETTING_DEFINITIONS, FUP_SETTING_KEYS, FupSettingsError, effectivePeakPercent, invalidateFupSettingsCache, listFupSettingsHistory,
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

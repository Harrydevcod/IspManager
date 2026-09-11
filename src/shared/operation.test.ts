import { expect, test } from 'vitest';
import {
  CPE_OPERATION_MODES,
  DEFAULT_OPERATION_MODES,
  OPERATION_MODES,
  isKnownOperationMode,
  operationModesForType,
  labelForOperationMode,
  shortLabelForOperationMode
} from './operation';

/**
 * O papel é uma etiqueta e nada mais: ao contrário do modo de ligação, não há
 * função nenhuma aqui que decida comportamento. Se um dia alguém acrescentar uma,
 * este ficheiro é onde se vê que ela apareceu.
 */
test('labels every predefined mode, long and short', () => {
  for (const mode of OPERATION_MODES) {
    expect(labelForOperationMode(mode)).not.toBe('');
    expect(shortLabelForOperationMode(mode)).not.toBe('');
  }
  expect(labelForOperationMode('ap')).toBe('Ponto de Acesso (AP)');
  expect(shortLabelForOperationMode('ap')).toBe('AP');
});

/** pt-PT: diz-se *router*, não "roteador". A norma do sistema inteiro. */
test('o rótulo do router é pt-PT', () => {
  expect(labelForOperationMode('router')).toBe('Router');
  expect(labelForOperationMode('router')).not.toMatch(/[Rr]oteador/);
});

/**
 * A CPE fica com os sete — o firmware dá-lhe todos — mas começada pelos que são
 * dela: quem abre o formulário com uma CPE à frente escolhe `cliente` quase
 * sempre, e é esse que tem de estar à cabeça.
 */
test('a CPE oferece tudo, com os modos dela à cabeça', () => {
  for (const type of ['cpe', 'antena', '  CPE  ', 'Antena']) {
    expect(operationModesForType(type)).toBe(CPE_OPERATION_MODES);
  }
  expect(CPE_OPERATION_MODES[0]).toBe('cliente');
  expect([...CPE_OPERATION_MODES].sort()).toEqual([...OPERATION_MODES].sort());
});

/**
 * `cliente` e `wisp` são modos de quem capta rádio: num router de casa ou num
 * switch não existem, e a lista não os oferece.
 */
test('o resto do equipamento não recebe os modos de quem capta rádio', () => {
  for (const type of ['router', 'switch', 'suporte', 'ap']) {
    expect(operationModesForType(type)).toBe(DEFAULT_OPERATION_MODES);
  }
  expect(DEFAULT_OPERATION_MODES).not.toContain('cliente');
  expect(DEFAULT_OPERATION_MODES).not.toContain('wisp');
  expect(DEFAULT_OPERATION_MODES[0]).toBe('router');
});

/** O tipo é texto livre desde a 0047: o que não se reconhece cai no resto. */
test('tipo escrito à mão, desconhecido ou em falta cai no conjunto do resto', () => {
  for (const type of ['fonte PoE', 'qualquer coisa', '', '   ', null, undefined]) {
    expect(operationModesForType(type)).toBe(DEFAULT_OPERATION_MODES);
  }
});

/** Oferecer um modo sem rótulo não compila — e sem registo, nem se oferece. */
test('as duas listas só contêm modos registados', () => {
  for (const mode of [...CPE_OPERATION_MODES, ...DEFAULT_OPERATION_MODES]) {
    expect(isKnownOperationMode(mode)).toBe(true);
  }
});

/** O outro lado do AP: a CPE/antena em modo Cliente (Client/Station). */
test('o Cliente é o par do AP', () => {
  expect(labelForOperationMode('cliente')).toBe('Cliente (Client / Station)');
  expect(shortLabelForOperationMode('cliente')).toBe('Cliente');
});

/**
 * O rótulo longo da Ponte diz o eixo de propósito: há um `bridge` no modo de
 * ligação que quer dizer outra coisa (não ter endereço próprio). Estes dois
 * campos vivem na mesma ficha e sem isto trocavam-se.
 */
test('a Ponte diz a que eixo pertence', () => {
  expect(labelForOperationMode('ponte')).toContain('Media Bridge');
  expect(labelForOperationMode('ponte')).toContain('Wi-Fi para cabo');
  expect(shortLabelForOperationMode('ponte')).toBe('Ponte');
});

/**
 * O WISP é o Cliente com router por dentro: o rótulo longo tem de os separar,
 * senão quem classifica no terreno escolhe um pelo outro.
 */
test('o WISP diz o que o separa do Cliente', () => {
  expect(labelForOperationMode('wisp')).toContain('Router/NAT');
  expect(shortLabelForOperationMode('wisp')).toBe('WISP');
});

/** Um modo escrito à mão é só uma etiqueta: mostra-se à letra e não decide nada. */
test('a hand-written mode is echoed verbatim', () => {
  expect(isKnownOperationMode('AP Router')).toBe(false);
  expect(labelForOperationMode('AP Router')).toBe('AP Router');
  expect(shortLabelForOperationMode('AP Router')).toBe('AP Router');
});

/** Por classificar não é um modo — é a ausência de um, e diz-se com vazio. */
test('an unregistered mode has no label', () => {
  for (const value of [null, undefined, '', '   ']) {
    expect(labelForOperationMode(value)).toBe('');
    expect(shortLabelForOperationMode(value)).toBe('');
    expect(isKnownOperationMode(value)).toBe(false);
  }
});

/** Maiúsculas e espaços do formulário não podem criar um modo "desconhecido". */
test('normalizes case and whitespace', () => {
  expect(isKnownOperationMode('  Router ')).toBe(true);
  expect(labelForOperationMode('  MESH ')).toBe('Mesh');
});

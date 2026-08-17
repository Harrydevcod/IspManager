import { describe, expect, test } from 'vitest';
import { crossReference, type CrossRefInput, type ObservedHost } from './network-inventory';
import type { RegisteredIp, SeenHostRow } from './network-discovery';

const RANGE = ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5'];

const observed = (ip: string, over: Partial<ObservedHost> = {}): ObservedHost => ({
  ip,
  mac: null,
  hostname: null,
  source: 'ping',
  rttMs: 3,
  ...over
});

const registered = (ip: string, over: Partial<RegisteredIp> = {}): RegisteredIp => ({
  ip,
  kind: 'assignment',
  id: 1,
  name: 'Sr. Silva',
  ...over
});

function report(over: Partial<CrossRefInput> = {}) {
  return crossReference({ rangeIps: RANGE, observed: [], registered: [], seen: [], ...over });
}

describe('crossReference — as categorias', () => {
  test('vivo e sem registo é desconhecido — o achado da ferramenta', () => {
    const { rows, counts } = report({ observed: [observed('192.168.1.3')] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip: '192.168.1.3', category: 'desconhecido', alive: true });
    expect(counts.desconhecido).toBe(1);
  });

  test('vivo e registado é registado, e traz o nome do dono', () => {
    const { rows, counts } = report({
      observed: [observed('192.168.1.2')],
      registered: [registered('192.168.1.2')]
    });
    expect(rows[0].category).toBe('registado');
    expect(rows[0].registeredAs).toEqual([{ kind: 'assignment', id: 1, name: 'Sr. Silva' }]);
    expect(counts.registado).toBe(1);
  });

  test('registado dentro do intervalo mas sem resposta é ausente', () => {
    const { rows, counts } = report({ registered: [registered('192.168.1.2')] });
    expect(rows[0]).toMatchObject({ category: 'ausente', alive: false, rttMs: null });
    expect(counts.ausente).toBe(1);
  });

  test('o mesmo IP em dois registos é duplicado, mesmo estando vivo', () => {
    const { rows, counts } = report({
      observed: [observed('192.168.1.2')],
      registered: [
        registered('192.168.1.2', { id: 1, name: 'Sr. Silva' }),
        registered('192.168.1.2', { id: 2, name: 'Sra. Costa' })
      ]
    });
    expect(rows[0].category).toBe('duplicado');
    expect(rows[0].registeredAs.map((r) => r.name)).toEqual(['Sr. Silva', 'Sra. Costa']);
    expect(counts.duplicado).toBe(1);
    // Um duplicado nunca é contado também como registado.
    expect(counts.registado).toBe(0);
  });

  test('duplicado aparece mesmo fora do intervalo varrido — é verdade sobre a BD', () => {
    const { rows } = report({
      rangeIps: [],
      registered: [registered('10.9.9.9', { id: 1 }), registered('10.9.9.9', { id: 2 })]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('duplicado');
  });

  test('registado fora do intervalo varrido não vira "ausente" fantasma', () => {
    const { rows } = report({ registered: [registered('10.9.9.9')] });
    expect(rows).toHaveLength(0);
  });
});

describe('crossReference — endereços livres', () => {
  test('livre é o que não responde e não tem dono, dentro do intervalo', () => {
    const result = report({
      observed: [observed('192.168.1.3')],
      registered: [registered('192.168.1.1')]
    });
    expect(result.freeIps).toEqual(['192.168.1.2', '192.168.1.4', '192.168.1.5']);
    expect(result.nextFreeIp).toBe('192.168.1.2');
    expect(result.counts.livre).toBe(3);
  });

  test('sem intervalo varrido não há livres a declarar', () => {
    const result = report({ rangeIps: [], registered: [registered('10.9.9.9')] });
    expect(result.freeIps).toEqual([]);
    expect(result.nextFreeIp).toBeNull();
    // "Ainda não perguntei" tem de ser distinguível de "não há nada livre",
    // senão a interface mostra um zero que é mentira.
    expect(result.rangeSize).toBe(0);
  });

  test('o relatório diz quantos endereços foram varridos', () => {
    const result = report({ observed: [observed('192.168.1.3')] });
    expect(result.rangeSize).toBe(RANGE.length);
  });

  test('intervalo cheio não sugere endereço nenhum', () => {
    const result = report({ observed: RANGE.map((ip) => observed(ip)) });
    expect(result.nextFreeIp).toBeNull();
  });
});

describe('crossReference — fusão de fontes e histórico', () => {
  const seen = (over: Partial<SeenHostRow> = {}): SeenHostRow => ({
    ipAddress: '192.168.1.3',
    macAddress: '50:C7:BF:AA:BB:CC',
    hostname: 'cpe-silva',
    vendor: 'TP-LINK',
    source: 'arp',
    firstSeenAt: '2026-01-05 10:00:00',
    lastSeenAt: '2026-08-01 10:00:00',
    timesSeen: 12,
    ...over
  });

  test('o histórico preenche MAC e nome quando o varrimento não os trouxe', () => {
    const { rows } = report({ observed: [observed('192.168.1.3')], seen: [seen()] });
    expect(rows[0]).toMatchObject({
      mac: '50:C7:BF:AA:BB:CC',
      hostname: 'cpe-silva',
      vendor: 'TP-LINK',
      firstSeenAt: '2026-01-05 10:00:00'
    });
  });

  test('o que foi visto agora ganha ao histórico', () => {
    const { rows } = report({
      observed: [observed('192.168.1.3', { mac: '00:0C:42:11:22:33', hostname: 'router-novo' })],
      seen: [seen()]
    });
    expect(rows[0].mac).toBe('00:0C:42:11:22:33');
    expect(rows[0].hostname).toBe('router-novo');
    expect(rows[0].vendor).toBe('Routerboard.com');
  });

  test('histórico de um IP que não respondeu agora não inventa uma linha', () => {
    const { rows } = report({ seen: [seen({ ipAddress: '192.168.1.4' })] });
    expect(rows).toHaveLength(0);
  });
});

describe('crossReference — ordenação', () => {
  test('as linhas saem por ordem numérica de IP, não alfabética', () => {
    const range = ['192.168.1.2', '192.168.1.10', '192.168.1.100'];
    const { rows } = crossReference({
      rangeIps: range,
      observed: range.map((ip) => observed(ip)),
      registered: [],
      seen: []
    });
    expect(rows.map((r) => r.ip)).toEqual(['192.168.1.2', '192.168.1.10', '192.168.1.100']);
  });
});

import { describe, expect, test } from 'vitest';
import { crossReference, sameModel, type CrossRefInput, type ObservedHost } from './network-inventory';
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
  model: null,
  active: true,
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
    expect(rows[0].registeredAs).toEqual([
      { kind: 'assignment', id: 1, name: 'Sr. Silva', active: true, model: null }
    ]);
    expect(counts.registado).toBe(1);
  });

  test('registado dentro do intervalo mas sem resposta é ausente', () => {
    const { rows, counts } = report({ registered: [registered('192.168.1.2')] });
    expect(rows[0]).toMatchObject({ category: 'ausente', alive: false, rttMs: null });
    expect(counts.ausente).toBe(1);
  });

  test('registo parado e sem resposta é reservado, não avaria', () => {
    const { rows, counts } = report({ registered: [registered('192.168.1.2', { active: false })] });
    expect(rows[0]).toMatchObject({ category: 'reservado', alive: false });
    expect(counts.reservado).toBe(1);
    expect(counts.ausente).toBe(0);
  });

  test('um registo ativo no mesmo IP manda: continua a ser avaria', () => {
    const { rows } = report({
      registered: [
        registered('192.168.1.2', { id: 1, active: false }),
        registered('192.168.1.2', { id: 1, active: true })
      ]
    });
    // Dois registos no mesmo IP são duplicado; o que interessa aqui é que a
    // presença de um ativo nunca deixa o endereço passar por reservado.
    expect(rows[0].category).not.toBe('reservado');
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

  test('um endereço reservado nunca entra nos livres', () => {
    const result = report({ registered: [registered('192.168.1.2', { active: false })] });
    expect(result.freeIps).not.toContain('192.168.1.2');
    expect(result.nextFreeIp).toBe('192.168.1.1');
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
    model: null,
    modelSource: null,
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

// ------------------------------------------------------------------ modelo

describe('sameModel', () => {
  test('o catálogo e o aparelho dizem o mesmo com palavras diferentes', () => {
    expect(sameModel('TP-Link CPE710', 'CPE710')).toBe(true);
    expect(sameModel('CPE710', 'CPE710(EU) v2.0')).toBe(true);
    expect(sameModel('TL-WR841N', 'tl wr841n')).toBe(true);
  });

  test('aparelhos diferentes continuam diferentes', () => {
    expect(sameModel('TP-Link CPE710', 'CPE210')).toBe(false);
    expect(sameModel('RB951Ui-2HnD', 'CPE710')).toBe(false);
  });
});

describe('crossReference — que aparelho é', () => {
  const registeredCpe = (model: string | null) =>
    registered('192.168.1.3', { kind: 'assignment', model });

  test('o modelo do registo ganha ao sondado', () => {
    const { rows } = crossReference({
      rangeIps: RANGE,
      observed: [observed('192.168.1.3')],
      registered: [registeredCpe('TP-Link CPE710')],
      seen: [{
        ipAddress: '192.168.1.3',
        macAddress: null,
        hostname: null,
        vendor: null,
        model: 'CPE710(EU) v2.0',
        modelSource: 'snmp',
        source: 'ping',
        firstSeenAt: '2026-01-05 10:00:00',
        lastSeenAt: '2026-08-01 10:00:00',
        timesSeen: 2
      }]
    });

    const row = rows.find((r) => r.ip === '192.168.1.3');
    expect(row?.model).toBe('TP-Link CPE710');
    expect(row?.modelSource).toBe('registo');
    // Os dois concordam — nada a assinalar.
    expect(row?.modelMismatch).toBe(false);
  });

  test('registo e rede a discordarem levantam o aviso', () => {
    const { rows } = crossReference({
      rangeIps: RANGE,
      observed: [observed('192.168.1.3')],
      registered: [registeredCpe('TP-Link CPE210')],
      seen: [{
        ipAddress: '192.168.1.3',
        macAddress: null,
        hostname: null,
        vendor: null,
        model: 'CPE710(EU) v2.0',
        modelSource: 'snmp',
        source: 'ping',
        firstSeenAt: '2026-01-05 10:00:00',
        lastSeenAt: '2026-08-01 10:00:00',
        timesSeen: 2
      }]
    });

    expect(rows.find((r) => r.ip === '192.168.1.3')?.modelMismatch).toBe(true);
  });

  test('sem registo, vale o que a rede respondeu', () => {
    const { rows } = crossReference({
      rangeIps: RANGE,
      observed: [observed('192.168.1.3')],
      registered: [],
      seen: [{
        ipAddress: '192.168.1.3',
        macAddress: null,
        hostname: null,
        vendor: null,
        model: 'RB951Ui-2HnD',
        modelSource: 'router',
        source: 'router',
        firstSeenAt: '2026-01-05 10:00:00',
        lastSeenAt: '2026-08-01 10:00:00',
        timesSeen: 2
      }]
    });

    const row = rows.find((r) => r.ip === '192.168.1.3');
    expect(row?.model).toBe('RB951Ui-2HnD');
    expect(row?.modelSource).toBe('router');
    expect(row?.modelMismatch).toBe(false);
  });

  test('sem modelo nenhum a linha não inventa um', () => {
    const { rows } = report({ observed: [observed('192.168.1.3')] });
    const row = rows.find((r) => r.ip === '192.168.1.3');
    expect(row?.model).toBeNull();
    expect(row?.modelSource).toBeNull();
  });
});

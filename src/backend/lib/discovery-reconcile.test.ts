import { describe, expect, test } from 'vitest';
import { buildProposals, dismissalKey, findOrphans, matchRegistryToNetwork } from './discovery-reconcile';
import type { RegisteredDevice, SeenHostRow } from './network-discovery';

const device = (over: Partial<RegisteredDevice> = {}): RegisteredDevice => ({
  ip: '192.168.1.10',
  mac: null,
  kind: 'assignment',
  id: 1,
  name: 'Sr. Silva',
  active: true,
  model: null,
  catalogId: 5,
  catalogType: 'cpe',
  ...over
});

const host = (over: Partial<SeenHostRow> = {}): SeenHostRow => ({
  ipAddress: '192.168.1.10',
  macAddress: '50:C7:BF:AA:BB:CC',
  hostname: null,
  vendor: 'TP-LINK',
  source: 'ping',
  firstSeenAt: '2026-01-01 10:00:00',
  lastSeenAt: '2026-08-27 10:00:00',
  timesSeen: 5,
  model: null,
  modelSource: null,
  ...over
});

const NOW = '2026-08-27 12:00:00';

// ------------------------------------------------------------- casamento

describe('matchRegistryToNetwork', () => {
  test('com MAC no registo casa pelo MAC, mesmo com o endereço trocado', () => {
    // O caso do router em DHCP: desligou, religou, apanhou outro endereço.
    const matches = matchRegistryToNetwork(
      [device({ ip: '192.168.1.50', mac: '50:C7:BF:AA:BB:CC' })],
      [host({ ipAddress: '192.168.1.77' })]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].via).toBe('mac');
    expect(matches[0].host.ipAddress).toBe('192.168.1.77');
  });

  test('sem MAC no registo casa pelo endereço — é assim que ganha o primeiro', () => {
    const matches = matchRegistryToNetwork([device({ mac: null })], [host()]);
    expect(matches[0].via).toBe('ip');
  });

  test('o mesmo aparelho em dois endereços vale pelo mais recente', () => {
    // A tabela é chaveada pelo IP: um router que saltou deixa a linha antiga.
    const matches = matchRegistryToNetwork(
      [device({ ip: null, mac: '50:C7:BF:AA:BB:CC' })],
      [
        host({ ipAddress: '192.168.1.50', lastSeenAt: '2026-08-01 10:00:00' }),
        host({ ipAddress: '192.168.1.77', lastSeenAt: '2026-08-27 10:00:00' })
      ]
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].host.ipAddress).toBe('192.168.1.77');
  });

  test('dois registos a reclamar o mesmo aparelho caem os dois', () => {
    const matches = matchRegistryToNetwork(
      [device({ id: 1 }), device({ id: 2 })],
      [host()]
    );
    expect(matches).toEqual([]);
  });

  test('registo sem endereço nem MAC não casa com nada', () => {
    expect(matchRegistryToNetwork([device({ ip: null, mac: null })], [host()])).toEqual([]);
  });

  test('MAC do registo em formato diferente casa na mesma', () => {
    const matches = matchRegistryToNetwork(
      [device({ ip: null, mac: '50:C7:BF:AA:BB:CC' })],
      [host({ macAddress: '50-c7-bf-aa-bb-cc' })]
    );
    expect(matches).toHaveLength(1);
  });
});

// ------------------------------------------------------------- propostas

describe('buildProposals', () => {
  test('registo com endereço e sem MAC ganha proposta de MAC', () => {
    const [proposal] = buildProposals({ devices: [device()], hosts: [host()], now: NOW });
    expect(proposal).toMatchObject({
      kind: 'mac_em_falta',
      targetKind: 'assignment',
      targetId: 1,
      current: null,
      proposed: '50:C7:BF:AA:BB:CC'
    });
  });

  test('o router que mudou de endereço propõe o endereço novo, não outro MAC', () => {
    const proposals = buildProposals({
      devices: [device({ ip: '192.168.1.50', mac: '50:C7:BF:AA:BB:CC' })],
      hosts: [host({ ipAddress: '192.168.1.77' })],
      now: NOW
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'ip_mudou', current: '192.168.1.50', proposed: '192.168.1.77' });
  });

  test('registo conhecido pelo MAC e sem endereço ganha proposta de endereço', () => {
    const [proposal] = buildProposals({
      devices: [device({ ip: null, mac: '50:C7:BF:AA:BB:CC' })],
      hosts: [host()],
      now: NOW
    });
    expect(proposal).toMatchObject({ kind: 'ip_em_falta', current: null, proposed: '192.168.1.10' });
  });

  test('nada a dizer quando o registo já bate certo com a rede', () => {
    const proposals = buildProposals({
      devices: [device({ mac: '50:C7:BF:AA:BB:CC' })],
      hosts: [host()],
      now: NOW
    });
    expect(proposals).toEqual([]);
  });

  test('modelo diferente propõe a diferença, com os dois lados à vista', () => {
    const [proposal] = buildProposals({
      devices: [device({ mac: '50:C7:BF:AA:BB:CC', model: 'Tp-Link CN TL-S5-5KM' })],
      hosts: [host({ model: 'TL-CPE500' })],
      now: NOW
    });
    expect(proposal).toMatchObject({
      kind: 'modelo_diferente',
      current: 'Tp-Link CN TL-S5-5KM',
      proposed: 'TL-CPE500'
    });
  });

  test('modelo que é o mesmo escrito de outra maneira não levanta proposta', () => {
    const proposals = buildProposals({
      devices: [device({ mac: '50:C7:BF:AA:BB:CC', model: 'TP-Link CPE 510 Ponto de Acesso' })],
      hosts: [host({ model: 'CPE510' })],
      now: NOW
    });
    expect(proposals).toEqual([]);
  });

  test('uma proposta dispensada não volta', () => {
    const dismissed = new Set([dismissalKey('mac_em_falta', 'assignment', 1)]);
    expect(buildProposals({ devices: [device()], hosts: [host()], dismissed, now: NOW })).toEqual([]);
  });

  test('dispensar uma proposta não cala as outras do mesmo equipamento', () => {
    const dismissed = new Set([dismissalKey('ip_mudou', 'assignment', 1)]);
    const proposals = buildProposals({
      devices: [device({ ip: '192.168.1.50', mac: '50:C7:BF:AA:BB:CC', model: 'TL-S5-5KM' })],
      hosts: [host({ ipAddress: '192.168.1.77', model: 'TL-CPE500' })],
      dismissed,
      now: NOW
    });
    expect(proposals.map((p) => p.kind)).toEqual(['modelo_diferente']);
  });

  describe('backbone ausente', () => {
    const torre = device({ kind: 'backbone', id: 9, name: 'Torre Norte', ip: '192.168.1.2' });

    test('ativo e sem resposta há mais de uma semana propõe manutenção', () => {
      const [proposal] = buildProposals({
        devices: [torre],
        hosts: [host({ ipAddress: '192.168.1.2', macAddress: null, lastSeenAt: '2026-08-01 10:00:00' })],
        now: NOW
      });
      expect(proposal).toMatchObject({
        kind: 'backbone_ausente',
        targetKind: 'backbone',
        targetId: 9,
        current: 'ativo',
        proposed: 'manutencao'
      });
    });

    test('visto ontem não é ausência nenhuma', () => {
      const proposals = buildProposals({
        devices: [torre],
        hosts: [host({ ipAddress: '192.168.1.2', macAddress: null, lastSeenAt: '2026-08-26 10:00:00' })],
        now: NOW
      });
      expect(proposals).toEqual([]);
    });

    test('nunca varrido não é o mesmo que não responde', () => {
      // Sem linha nenhuma no histórico não há observação a que chamar ausência.
      expect(buildProposals({ devices: [torre], hosts: [], now: NOW })).toEqual([]);
    });

    test('backbone já em manutenção ou abatido não se propõe outra vez', () => {
      const proposals = buildProposals({
        devices: [device({ kind: 'backbone', id: 9, ip: '192.168.1.2', active: false })],
        hosts: [host({ ipAddress: '192.168.1.2', macAddress: null, lastSeenAt: '2026-08-01 10:00:00' })],
        now: NOW
      });
      expect(proposals).toEqual([]);
    });
  });
});

// --------------------------------------------------- sem identidade na rede

describe('findOrphans', () => {
  const semIdentidade = device({ ip: null, mac: null, id: 7, name: 'Anilsa', model: 'TP-Link Archer C20' });

  test('lista quem não tem endereço nem MAC', () => {
    const [orphan] = findOrphans([semIdentidade], [], new Set());
    expect(orphan).toMatchObject({ targetKind: 'assignment', targetId: 7, name: 'Anilsa' });
  });

  test('quem tem endereço ou MAC não é órfão', () => {
    expect(findOrphans([device({ ip: '192.168.1.10', mac: null })], [], new Set())).toEqual([]);
    expect(findOrphans([device({ ip: null, mac: '50:C7:BF:AA:BB:CC' })], [], new Set())).toEqual([]);
  });

  test('os candidatos são os desconhecidos do mesmo fabricante', () => {
    const [orphan] = findOrphans(
      [semIdentidade],
      [
        host({ ipAddress: '192.168.1.80', vendor: 'TP-Link Technologies' }),
        host({ ipAddress: '192.168.1.81', vendor: 'MERCUSYS' })
      ],
      new Set()
    );
    expect(orphan.candidates.map((c) => c.ip)).toEqual(['192.168.1.80']);
  });

  test('endereço já reclamado por outro registo não entra nos candidatos', () => {
    const [orphan] = findOrphans(
      [semIdentidade],
      [host({ ipAddress: '192.168.1.80', vendor: 'TP-Link Technologies' })],
      new Set(['192.168.1.80'])
    );
    expect(orphan.candidates).toEqual([]);
  });

  /**
   * Vinte routers TP-Link registados e outros tantos desconhecidos na rede não
   * dão par único. A lista é para escolher, não é uma resposta — este teste
   * fixa que a função nunca decide por conta própria.
   */
  test('vários candidatos ficam todos, sem eleger nenhum', () => {
    const [orphan] = findOrphans(
      [semIdentidade],
      [
        host({ ipAddress: '192.168.1.80', vendor: 'TP-Link Technologies' }),
        host({ ipAddress: '192.168.1.81', vendor: 'TP-Link Technologies' })
      ],
      new Set()
    );
    expect(orphan.candidates).toHaveLength(2);
  });

  /**
   * Medido na rede real antes de existir este limite: 23 registos sem
   * identidade, cada um com **24** candidatos TP-Link. Isso não é uma lista
   * curta — é o palheiro com outro nome, e uma sugestão que não estreita nada
   * ensina a ignorar as que estreitam.
   */
  test('candidatos a mais é o mesmo que nenhum — cala-se', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      host({ ipAddress: `192.168.1.${80 + i}`, vendor: 'TP-Link Technologies' }));
    const [orphan] = findOrphans([semIdentidade], many, new Set());
    expect(orphan.candidates).toEqual([]);
  });

  test('mesmo à justa do limite ainda é uma escolha', () => {
    const six = Array.from({ length: 6 }, (_, i) =>
      host({ ipAddress: `192.168.1.${80 + i}`, vendor: 'TP-Link Technologies' }));
    const [orphan] = findOrphans([semIdentidade], six, new Set());
    expect(orphan.candidates).toHaveLength(6);
  });

  test('sem MAC não serve de candidato — não há o que escrever no registo', () => {
    const [orphan] = findOrphans(
      [semIdentidade],
      [host({ ipAddress: '192.168.1.80', vendor: 'TP-Link Technologies', macAddress: null })],
      new Set()
    );
    expect(orphan.candidates).toEqual([]);
  });
});

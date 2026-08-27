import { describe, expect, test } from 'vitest';
import {
  buildSnmpGet,
  describeBanner,
  identifyModel,
  modelFromBanner,
  parseRealm,
  parseSnmpString,
  parseTitle,
  type HttpBanner
} from './device-model';

// ------------------------------------------------------------------ SNMP

/**
 * Monta uma resposta SNMP como um agente a mandaria, para o parser ter algo
 * verdadeiro contra que se medir. Escrito à mão de propósito: usar o próprio
 * codificador do módulo para gerar o caso de teste provava só que ele é
 * coerente consigo mesmo.
 */
function snmpResponse(sysDescr: string, errorStatus = 0): Buffer {
  // Comprimento BER a sério: acima de 127 vai o número de bytes e depois os
  // bytes. Um `sysDescr` de 300 caracteres precisa mesmo de dois — encurtar
  // isto dava um pacote inválido e um teste que media o gerador, não o parser.
  const len = (payload: Buffer) => {
    if (payload.length < 0x80) return Buffer.from([payload.length]);
    const bytes: number[] = [];
    for (let rest = payload.length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tlv = (tag: number, payload: Buffer) => Buffer.concat([Buffer.from([tag]), len(payload), payload]);

  const oid = tlv(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]));
  const value = tlv(0x04, Buffer.from(sysDescr, 'latin1'));
  const varbindList = tlv(0x30, tlv(0x30, Buffer.concat([oid, value])));
  const pdu = tlv(0xa2, Buffer.concat([
    tlv(0x02, Buffer.from([0x01])),
    tlv(0x02, Buffer.from([errorStatus])),
    tlv(0x02, Buffer.from([0x00])),
    varbindList
  ]));
  return tlv(0x30, Buffer.concat([
    tlv(0x02, Buffer.from([0x01])),
    tlv(0x04, Buffer.from('public', 'latin1')),
    pdu
  ]));
}

describe('buildSnmpGet', () => {
  test('é um GetRequest v2c pela community e pelo OID do sysDescr', () => {
    const packet = buildSnmpGet(42);
    expect(packet[0]).toBe(0x30); // SEQUENCE
    expect(packet.includes(Buffer.from('public', 'latin1'))).toBe(true);
    expect(packet.includes(Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]))).toBe(true);
    // 0xA0 = GetRequest. Sem isto o agente responde a outra pergunta.
    expect(packet.includes(Buffer.from([0xa0]))).toBe(true);
  });

  test('um pedido longo não estoura o comprimento BER', () => {
    // Uma community grande empurra o comprimento total para lá de 127, que é
    // onde a codificação passa a precisar de mais de um byte.
    const packet = buildSnmpGet(1, 'x'.repeat(200));
    expect(packet[1] & 0x80).toBeTruthy();
    expect(packet.length).toBeGreaterThan(200);
  });
});

describe('parseSnmpString', () => {
  test('tira o sysDescr de uma resposta bem formada', () => {
    expect(parseSnmpString(snmpResponse('CPE710(EU) v2.0'))).toBe('CPE710(EU) v2.0');
  });

  test('normaliza o espaço branco de descrições multilinha', () => {
    expect(parseSnmpString(snmpResponse('RouterOS\n  RB951Ui-2HnD'))).toBe('RouterOS RB951Ui-2HnD');
  });

  test('uma descrição longa (comprimento em dois bytes) lê-se na mesma', () => {
    const long = 'A'.repeat(300);
    expect(parseSnmpString(snmpResponse(long))).toBe(long);
  });

  test('erro do agente não vira nome de modelo', () => {
    expect(parseSnmpString(snmpResponse('CPE710', 2))).toBeNull();
  });

  test('lixo, pedido truncado ou vazio devolvem null em vez de adivinhar', () => {
    expect(parseSnmpString(Buffer.from([0x30, 0x82, 0xff, 0xff]))).toBeNull();
    expect(parseSnmpString(Buffer.alloc(0))).toBeNull();
    expect(parseSnmpString(Buffer.from('não é SNMP nenhum'))).toBeNull();
    // Um GetRequest não é uma resposta: 0xA0 nunca pode passar por 0xA2.
    expect(parseSnmpString(buildSnmpGet(1))).toBeNull();
  });

  test('uma resposta com a cadeia vazia é ausência de modelo, não cadeia vazia', () => {
    expect(parseSnmpString(snmpResponse(''))).toBeNull();
  });
});

// ------------------------------------------------------------------ HTTP

describe('parseTitle', () => {
  test('apanha o título e limpa o espaço branco', () => {
    expect(parseTitle('<html><head><title>\n  TL-WR841N\n</title>')).toBe('TL-WR841N');
  });

  test('aceita atributos na etiqueta', () => {
    expect(parseTitle('<title lang="en">Pharos</title>')).toBe('Pharos');
  });

  test('sem título, ou com título vazio, devolve null', () => {
    expect(parseTitle('<html><body>nada</body></html>')).toBeNull();
    expect(parseTitle('<title>   </title>')).toBeNull();
  });
});

describe('parseRealm', () => {
  test('tira o realm do cabeçalho de autenticação', () => {
    expect(parseRealm('Basic realm="TP-LINK Wireless N Router WR841N"'))
      .toBe('TP-LINK Wireless N Router WR841N');
  });

  test('sem cabeçalho ou sem realm devolve null', () => {
    expect(parseRealm(null)).toBeNull();
    expect(parseRealm('Basic')).toBeNull();
  });
});

const banner = (over: Partial<HttpBanner> = {}): HttpBanner => ({
  scheme: 'http',
  status: 200,
  server: null,
  realm: null,
  title: null,
  ...over
});

describe('modelFromBanner', () => {
  /**
   * A tabela de assinaturas nasce vazia de propósito — enche-se com o que a
   * rede real responder, nunca com palpites. Este teste guarda essa decisão:
   * enquanto não houver prova, o canal HTTP não inventa modelo nenhum.
   */
  test('sem assinaturas provadas não devolve modelo', () => {
    expect(modelFromBanner(banner({ title: 'Login' }))).toBeNull();
  });
});

describe('describeBanner', () => {
  test('guarda a prova toda numa linha só', () => {
    expect(describeBanner(banner({ status: 401, title: 'Login', server: 'lighttpd', realm: 'CPE' })))
      .toBe('http 401 | title=Login | realm=CPE | server=lighttpd');
  });

  test('o que o equipamento não deu não aparece', () => {
    expect(describeBanner(banner({ status: 200 }))).toBe('http 200');
  });
});

// --------------------------------------------------------- orquestração

describe('identifyModel', () => {
  test('o SNMP responde e nem se chega a bater à porta do servidor web', async () => {
    let httpCalls = 0;
    const result = await identifyModel('192.168.1.10', {
      snmp: async () => 'CPE710(EU) v2.0',
      http: async () => {
        httpCalls += 1;
        return banner();
      }
    });

    expect(result).toEqual({ model: 'CPE710(EU) v2.0', source: 'snmp', detail: 'CPE710(EU) v2.0' });
    expect(httpCalls).toBe(0);
  });

  test('sem SNMP cai para o banner HTTP e guarda a prova', async () => {
    const result = await identifyModel('192.168.1.11', {
      snmp: async () => null,
      http: async () => banner({ status: 401, title: 'Login', realm: 'CPE510' })
    });

    // Sem assinatura provada não há modelo — mas fica a resposta em bruto, que
    // é exatamente o que permite escrever a assinatura que falta.
    expect(result?.source).toBe('http');
    expect(result?.model).toBeNull();
    expect(result?.detail).toContain('realm=CPE510');
  });

  test('quem não responde a nada não gera linha nenhuma', async () => {
    const result = await identifyModel('192.168.1.12', {
      snmp: async () => null,
      http: async () => null
    });
    expect(result).toBeNull();
  });

  test('um sysDescr enorme corta-se ao que cabe na tabela, sem perder a prova', async () => {
    const long = 'B'.repeat(400);
    const result = await identifyModel('192.168.1.13', { snmp: async () => long });
    expect(result?.model).toHaveLength(120);
    expect(result?.detail).toHaveLength(400);
  });
});

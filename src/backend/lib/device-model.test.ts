import { describe, expect, test } from 'vitest';
import {
  buildSnmpGet,
  describeBanner,
  identifyModel,
  modelFromBanner,
  parseRealm,
  parseSnmpString,
  parseTitle,
  readHttpBanner,
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
  bodyHead: '',
  ...over
});

/**
 * Corpo de uma página de CPE Pharos, tal como veio da rede em 2026-08-27.
 * Copiado da sondagem, não inventado — é a única forma de este teste provar
 * alguma coisa sobre o firmware real.
 */
const pharosBody = (code: string, region = 'EU') =>
  `<HTML><BODY>
redirected to https://192.168.1.111:443
</BODY></HTML>
` +
  `<script language=JavaScript>
var productInfo = new Array(
"${region}",
"pt",
1,
${code},
0,0 );
</script>`;

describe('modelFromBanner', () => {
  // Cada caso aqui saiu de um equipamento real do parque, confirmado contra o
  // que o ISPM tem registado para esse endereço.

  test('CPE510: o título diz só "Pharos" — o modelo está no productInfo', () => {
    const row = banner({ status: 303, title: 'Pharos', server: 'TP-LINK HTTPD/1.0', bodyHead: pharosBody('276') });
    expect(modelFromBanner(row)).toBe('CPE510');
  });

  test('CPE710: outro código, outro modelo', () => {
    const row = banner({ status: 303, title: 'Pharos', server: 'HTTPD', bodyHead: pharosBody('620', 'UN') });
    expect(modelFromBanner(row)).toBe('CPE710');
  });

  /**
   * O `Server` dividia o parque medido em 13 e 5, e os modelos em 16 e 2 — não
   * é o mesmo corte. Este teste fixa isso: dois equipamentos com o mesmo
   * cabeçalho e códigos diferentes têm de dar modelos diferentes.
   */
  test('o cabeçalho Server não decide o modelo — o código decide', () => {
    const same = { status: 303, title: 'Pharos', server: 'TP-LINK HTTPD/1.0' };
    expect(modelFromBanner(banner({ ...same, bodyHead: pharosBody('276') }))).toBe('CPE510');
    expect(modelFromBanner(banner({ ...same, bodyHead: pharosBody('620') }))).toBe('CPE710');
  });

  test('um código Pharos desconhecido diz o código em vez de inventar um modelo', () => {
    expect(modelFromBanner(banner({ title: 'Pharos', bodyHead: pharosBody('999') })))
      .toBe('Pharos (código 999)');
  });

  test('os TL-* trazem a referência no título', () => {
    expect(modelFromBanner(banner({ title: 'TL-S5-5KM' }))).toBe('TL-S5-5KM');
    expect(modelFromBanner(banner({ title: 'TL-CPE500' }))).toBe('TL-CPE500');
  });

  test('o "TL-" só vale no título, não perdido no meio de uma página', () => {
    expect(modelFromBanner(banner({ title: 'Login', bodyHead: 'compre o seu TL-WR841N hoje' }))).toBeNull();
  });

  test('o router da Starlink identifica-se', () => {
    expect(modelFromBanner(banner({ title: 'Starlink' }))).toBe('Starlink');
  });

  /**
   * No parque medido, o lighttpd das NanoStation e os títulos de lixo não
   * chegam para dizer o modelo. Preferimos a coluna vazia a uma etiqueta
   * inventada — o fabricante já vem do MAC.
   */
  test('o que não chega para identificar não se adivinha', () => {
    expect(modelFromBanner(banner({ status: 302, server: 'lighttpd/1.4.54' }))).toBeNull();
    expect(modelFromBanner(banner({ title: 'Opening...' }))).toBeNull();
    expect(modelFromBanner(banner({ status: 302, server: 'GoAhead-Webs' }))).toBeNull();
    expect(modelFromBanner(banner())).toBeNull();
  });
});

describe('readHttpBanner — quando o :80 responde e não diz nada', () => {
  // As NanoStation do parque servem no `:80` um 302 de corpo vazio que manda
  // para o `:443`. Parar no primeiro que responde deixava-as por identificar.
  test('um 302 vazio no :80 não impede a leitura do :443', async () => {
    const seen: string[] = [];
    const banners: Record<string, HttpBanner | null> = {
      http: banner({ status: 302, server: 'lighttpd/1.4.54' }),
      https: banner({ scheme: 'https', status: 200, title: 'Ubiquiti', server: 'lighttpd/1.4.54' })
    };
    // A ordem importa: o :443 só se paga quando o :80 não disse nada.
    const result = await readHttpBanner('192.168.1.169', 10, async (_ip, scheme) => {
      seen.push(scheme);
      return banners[scheme];
    });
    expect(seen).toEqual(['http', 'https']);
    expect(result?.title).toBe('Ubiquiti');
  });

  test('um :80 com título não paga o aperto de mão TLS', async () => {
    const seen: string[] = [];
    const result = await readHttpBanner('192.168.1.117', 10, async (_ip, scheme) => {
      seen.push(scheme);
      return banner({ title: 'TL-S5-5KM' });
    });
    expect(seen).toEqual(['http']);
    expect(result?.title).toBe('TL-S5-5KM');
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
  test('havendo SNMP é ele que manda, mesmo com o banner a responder também', async () => {
    const result = await identifyModel('192.168.1.10', {
      snmp: async () => 'CPE710(EU) v2.0',
      http: async () => banner({ title: 'Pharos', bodyHead: pharosBody('276') })
    });

    expect(result).toEqual({ model: 'CPE710(EU) v2.0', source: 'snmp', detail: 'CPE710(EU) v2.0' });
  });

  /**
   * Em série, o silêncio do SNMP pagava-se em cada endereço — e no parque
   * medido ele calou-se em 42 de 42. Os dois canais têm de arrancar juntos.
   */
  test('os dois canais arrancam ao mesmo tempo', async () => {
    const started: string[] = [];
    await identifyModel('192.168.1.11', {
      snmp: async () => {
        started.push('snmp');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return null;
      },
      http: async () => {
        started.push('http');
        return banner();
      }
    });

    // O HTTP arrancou sem esperar que o SNMP desistisse.
    expect(started).toEqual(['snmp', 'http']);
  });

  test('sem SNMP cai para o banner HTTP e guarda a prova', async () => {
    const result = await identifyModel('192.168.1.11', {
      snmp: async () => null,
      http: async () => banner({ status: 303, title: 'Pharos', server: 'HTTPD', bodyHead: pharosBody('620', 'UN') })
    });

    expect(result?.source).toBe('http');
    expect(result?.model).toBe('CPE710');
    // O `detail` guarda o banner, não o corpo: é o que se lê para perceber uma
    // linha errada, e 4 KB de página não cabem numa coluna.
    expect(result?.detail).toBe('http 303 | title=Pharos | server=HTTPD');
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

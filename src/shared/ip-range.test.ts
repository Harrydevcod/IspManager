import { describe, expect, test } from 'vitest';
import { chunk, expandRange, intToIp, ipToInt, isIpv4, MAX_SWEEP_HOSTS } from './ip-range';

describe('ipToInt / intToIp', () => {
  test('vai e volta', () => {
    for (const ip of ['0.0.0.0', '192.168.1.1', '10.0.0.255', '255.255.255.255']) {
      expect(intToIp(ipToInt(ip)!)).toBe(ip);
    }
  });

  test('rejeita octetos acima de 255 e lixo', () => {
    for (const bad of ['192.168.1.256', '192.168.1', '192.168.1.1.1', 'abc', '', '1.2.3.-1']) {
      expect(ipToInt(bad)).toBeNull();
      expect(isIpv4(bad)).toBe(false);
    }
  });

  test('255.255.255.255 não estoura para negativo', () => {
    expect(ipToInt('255.255.255.255')).toBe(4294967295);
  });
});

describe('expandRange — CIDR', () => {
  test('/24 exclui rede e broadcast', () => {
    const ips = expandRange('192.168.1.0/24');
    expect(ips).toHaveLength(254);
    expect(ips[0]).toBe('192.168.1.1');
    expect(ips.at(-1)).toBe('192.168.1.254');
  });

  test('aplica a máscara a um endereço qualquer da rede', () => {
    expect(expandRange('192.168.1.37/24')).toEqual(expandRange('192.168.1.0/24'));
  });

  test('/30 dá os dois endereços úteis', () => {
    expect(expandRange('10.0.0.0/30')).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  test('/31 e /32 não excluem nada — senão a lista vinha vazia', () => {
    expect(expandRange('10.0.0.0/31')).toEqual(['10.0.0.0', '10.0.0.1']);
    expect(expandRange('10.0.0.7/32')).toEqual(['10.0.0.7']);
  });

  test('máscara fora de /8../32 é recusada', () => {
    expect(() => expandRange('10.0.0.0/4')).toThrow(/Máscara inválida/);
    expect(() => expandRange('10.0.0.0/33')).toThrow(/Máscara inválida/);
  });
});

describe('expandRange — intervalo com hífen', () => {
  test('forma abreviada herda os três primeiros octetos', () => {
    const ips = expandRange('192.168.1.10-13');
    expect(ips).toEqual(['192.168.1.10', '192.168.1.11', '192.168.1.12', '192.168.1.13']);
  });

  test('forma completa', () => {
    expect(expandRange('10.0.0.254-10.0.1.1')).toEqual(['10.0.0.254', '10.0.0.255', '10.0.1.0', '10.0.1.1']);
  });

  test('endereço único sem hífen', () => {
    expect(expandRange('192.168.1.50')).toEqual(['192.168.1.50']);
  });

  test('fim antes do início é erro, não lista vazia silenciosa', () => {
    expect(() => expandRange('192.168.1.50-10')).toThrow(/vem antes do início/);
  });

  test('ignora espaços à volta', () => {
    expect(expandRange('  192.168.1.1-2  ')).toEqual(['192.168.1.1', '192.168.1.2']);
  });
});

describe('expandRange — limites', () => {
  test('vazio pede um intervalo', () => {
    expect(() => expandRange('   ')).toThrow(/Indique um intervalo/);
  });

  test('acima do teto recusa em vez de varrer', () => {
    expect(() => expandRange('10.0.0.0/16')).toThrow(/demasiado grande/);
    expect(() => expandRange('10.0.0.0-10.0.255.255')).toThrow(/demasiado grande/);
  });

  test('exatamente no teto passa', () => {
    // /22 = 1024 endereços, menos rede e broadcast = 1022.
    expect(expandRange('10.0.0.0/22')).toHaveLength(MAX_SWEEP_HOSTS - 2);
  });

  test('lixo é recusado com o texto do que falhou', () => {
    expect(() => expandRange('192.168.1.999-10')).toThrow(/Endereço inválido/);
    expect(() => expandRange('foo-bar')).toThrow(/Endereço inválido/);
  });
});

describe('chunk', () => {
  test('divide com resto', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('lista vazia dá zero lotes', () => {
    expect(chunk([], 64)).toEqual([]);
  });

  test('lote maior que a lista dá um lote', () => {
    expect(chunk([1, 2], 64)).toEqual([[1, 2]]);
  });

  test('tamanho inválido é erro', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

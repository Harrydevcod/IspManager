import { describe, expect, test } from 'vitest';
import { IPTV_SCRIPT_VERSION, iptvScriptMark, iptvSplitScript } from './routeros-iptv-script';

const input = { list: 'IPTV-SPLIT', users: ['skn017', 'skn014'], macs: ['BC:07:1D:5E:54:E7'] };

describe('iptvSplitScript', () => {
  test('embute utilizadores e MAC ordenados, entre aspas do RouterOS', () => {
    const source = iptvSplitScript(input);
    expect(source.split('\n')[0]).toBe(`# ${IPTV_SCRIPT_VERSION}`);
    expect(source).toContain(':local users {"skn014";"skn017"}');
    expect(source).toContain(':local macs {"BC:07:1D:5E:54:E7"}');
    expect(source).toContain('list="IPTV-SPLIT"');
    expect(source).toContain('dynamic=yes');
    expect(source).toContain('comment~"^ispm-iptv:"');
  });
  test('chaves em string, sem endereços vazios e sem ruído no registo', () => {
    const source = iptvSplitScript(input);
    expect(source).toContain('[:tostr [/ppp active get $a address]]');
    expect(source).toContain('[:tostr [/ip dhcp-server lease get $l address]]');
    expect(source).toContain(':local ad [:tostr [/ip firewall address-list get $e address]]');
    expect(source).toContain('!= ""');
    expect(source).not.toContain(':log');
    expect(source).not.toContain('on-error');
  });
  test('nunca usa números de linha', () => {
    expect(iptvSplitScript(input)).not.toMatch(/\b(remove|set|disable|enable) \d+\b/);
    expect(iptvSplitScript(input)).not.toMatch(/numbers=/);
  });
  test('recusa nomes e MAC que não são o que dizem ser', () => {
    expect(() => iptvSplitScript({ ...input, users: ['a"; /system reset-configuration'] })).toThrow('Utilizador PPPoE inválido');
    expect(() => iptvSplitScript({ ...input, macs: ['zz'] })).toThrow('MAC inválido');
    expect(() => iptvSplitScript({ ...input, list: 'x y' })).toThrow('Nome de lista inválido');
  });
  test('a marca muda quando o conteúdo muda, e só então', () => {
    expect(iptvScriptMark(iptvSplitScript(input))).toBe(iptvScriptMark(iptvSplitScript({ ...input, users: ['skn014', 'skn017'] })));
    expect(iptvScriptMark(iptvSplitScript(input))).not.toBe(iptvScriptMark(iptvSplitScript({ ...input, users: ['skn014'] })));
    expect(iptvScriptMark(iptvSplitScript(input))).toMatch(/^ispm-iptv v1 #[0-9a-f]{8}$/);
  });
});

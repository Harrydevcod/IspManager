import { describe, expect, test } from 'vitest';
import { DROP_CAPTURE_PREFIX, DROP_CAPTURE_SCRIPT_VERSION, dropCaptureScript } from './routeros-drop-capture-script';

describe('dropCaptureScript', () => {
  const source = dropCaptureScript();

  test('abre com a versão e escreve com o prefixo que a Saúde da rede procura', () => {
    expect(source.split('\n')[0]).toBe(`# ${DROP_CAPTURE_SCRIPT_VERSION}`);
    expect(source).toContain(`:log warning ("${DROP_CAPTURE_PREFIX} " . $h`);
    expect(source).toContain(`:log info "${DROP_CAPTURE_PREFIX} fim"`);
  });

  test('só conta como bloco duas ou mais antenas em baixo, e escreve uma vez por queda', () => {
    expect(source).toContain('find where status="down" !disabled]');
    expect(source).not.toContain('disabled=no');
    expect(source).toContain('[:len $down] < 2');
    expect(source).toContain(':if (!$was) do={');
    expect(source).toContain('/system scheduler set $me comment="em-queda"');
    expect(source).not.toContain(':global');
  });

  test('só escreve no próprio agendamento: nunca mexe no netwatch, no ARP nem na bridge', () => {
    expect(source.match(/\/[a-z ]+ (add|remove|set|disable|enable) /g)).toEqual(['/system scheduler set ', '/system scheduler set ']);
    expect(source).not.toMatch(/\/tool netwatch (add|set|remove)/);
  });

  test('as chaves e os valores vão em texto: um ARP sem MAC não rebenta a linha', () => {
    expect(source).toContain('[:tostr [/ip arp get $a mac-address]]');
    expect(source).toContain('$mac != "-" && $mac != ""');
  });
});

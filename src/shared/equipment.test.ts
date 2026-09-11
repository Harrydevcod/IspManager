import { expect, test } from 'vitest';
import { labelForType, requiresStaticIp } from './equipment';

/**
 * Qualquer equipamento pode levar endereço fixo — quem instala é que decide. A
 * lista diz só quem não pode ficar sem: o que aponta ao backbone, e é onde se vai
 * bater quando a ligação cai. É fácil inverter isto sem dar por ela.
 */
test('only backbone-facing equipment is required to have a static IP', () => {
  expect(requiresStaticIp('cpe')).toBe(true);
  expect(requiresStaticIp('antena')).toBe(true);

  expect(requiresStaticIp('ap')).toBe(false);
  expect(requiresStaticIp('repetidor')).toBe(false);
  expect(requiresStaticIp('router')).toBe(false);
  expect(requiresStaticIp('Ponto de Acesso Externo')).toBe(false);
  expect(requiresStaticIp(null)).toBe(false);
});

/**
 * O tipo sempre foi um substituto de uma pergunta que ninguém fazia: em que modo
 * está esta unidade? Desde a migração 0056 quem responde é o modo — e sem modo
 * registado a regra antiga tem de continuar a valer, senão o parque por
 * classificar deixava de avisar de um dia para o outro.
 */
test('the WAN mode decides, and the type only takes over when there is none', () => {
  // O modo manda: um CPE em DHCP não tem endereço para registar.
  expect(requiresStaticIp('cpe', 'dhcp')).toBe(false);
  expect(requiresStaticIp('antena', 'pppoe')).toBe(false);
  // E obriga onde o tipo não obrigava.
  expect(requiresStaticIp('router', 'static')).toBe(true);
  expect(requiresStaticIp('switch', 'pppoe_static')).toBe(true);

  // Sem modo, a regra antiga intacta.
  expect(requiresStaticIp('cpe', null)).toBe(true);
  expect(requiresStaticIp('cpe', '   ')).toBe(true);
  expect(requiresStaticIp('router', undefined)).toBe(false);

  // Modo escrito à mão é etiqueta, não regra — e não faz o tipo voltar a mandar.
  expect(requiresStaticIp('cpe', 'IPv6 nativo')).toBe(false);
});

test('labels the predefined types and echoes hand-written ones', () => {
  expect(labelForType('ap')).toBe('Ponto de Acesso');
  expect(labelForType('repetidor')).toBe('Repetidor WiFi');
  expect(labelForType('Seja o que for')).toBe('Seja o que for');
});

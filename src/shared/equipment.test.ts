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

test('labels the predefined types and echoes hand-written ones', () => {
  expect(labelForType('ap')).toBe('Ponto de Acesso');
  expect(labelForType('repetidor')).toBe('Repetidor WiFi');
  expect(labelForType('Seja o que for')).toBe('Seja o que for');
});

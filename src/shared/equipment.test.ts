import { expect, test } from 'vitest';
import { labelForType, takesStaticIp } from './equipment';

/**
 * Quem leva IP fixo é o que aponta ao backbone. O ponto de acesso e o repetidor
 * ficam atrás da antena e apanham DHCP — é a decisão, e é fácil de inverter sem
 * dar por isso ao mexer na lista.
 */
test('only backbone-facing equipment takes a static IP', () => {
  expect(takesStaticIp('cpe')).toBe(true);
  expect(takesStaticIp('antena')).toBe(true);

  expect(takesStaticIp('ap')).toBe(false);
  expect(takesStaticIp('repetidor')).toBe(false);
  expect(takesStaticIp('router')).toBe(false);
  expect(takesStaticIp(null)).toBe(false);
});

test('labels the predefined types and echoes hand-written ones', () => {
  expect(labelForType('ap')).toBe('Ponto de Acesso');
  expect(labelForType('repetidor')).toBe('Repetidor WiFi');
  expect(labelForType('Seja o que for')).toBe('Seja o que for');
});

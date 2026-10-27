import { expect, test } from 'vitest';
import { uptimeSeconds } from './duration';

test('lê a duração do RouterOS, com milissegundos ignorados', () => {
  expect(uptimeSeconds('1w2d3h4m5s')).toBe(604_800 + 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  expect(uptimeSeconds('5s300ms')).toBe(5);
  expect(uptimeSeconds('300ms')).toBe(0);
  expect(uptimeSeconds(null)).toBeNull();
  expect(uptimeSeconds('nunca')).toBeNull();
});

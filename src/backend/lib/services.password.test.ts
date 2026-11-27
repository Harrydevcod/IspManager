import { expect, test } from 'vitest';
import { generatePppoePassword, PPPOE_PASSWORD_ALPHABET } from './services';

test('as senhas PPPoE novas não têm caracteres ambíguos', () => {
  expect(PPPOE_PASSWORD_ALPHABET).not.toMatch(/[Il1O0o_-]/u);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const password = generatePppoePassword();
    expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{12}$/u);
    seen.add(password);
  }
  expect(seen.size).toBe(200);
});

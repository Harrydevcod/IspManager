import { expect, test } from 'vitest';
import {
  WAN_MODES,
  WAN_MODES_REQUIRING_IP_SQL,
  isKnownWanMode,
  labelForWanMode,
  shortLabelForWanMode,
  wanModeRequiresIp
} from './wan';

/**
 * Quem não pode ficar sem endereço registado. `pppoe_static` é o que se inverte
 * sem dar por ela: tem sessão PPPoE, mas o endereço fixo foi contratado e se não
 * estiver escrito ninguém sabe qual é.
 */
test('only the fixed-address modes require an IP', () => {
  expect(wanModeRequiresIp('static')).toBe(true);
  expect(wanModeRequiresIp('pppoe_static')).toBe(true);

  expect(wanModeRequiresIp('dhcp')).toBe(false);
  expect(wanModeRequiresIp('pppoe')).toBe(false);
  expect(wanModeRequiresIp('bridge')).toBe(false);
  expect(wanModeRequiresIp('tunnel')).toBe(false);
});

/** Um modo escrito à mão é uma etiqueta: não obriga a nada e não pinta o mapa. */
test('a hand-written mode carries no behaviour', () => {
  expect(wanModeRequiresIp('IPv6 nativo')).toBe(false);
  expect(isKnownWanMode('IPv6 nativo')).toBe(false);
  expect(labelForWanMode('IPv6 nativo')).toBe('IPv6 nativo');
  expect(shortLabelForWanMode('IPv6 nativo')).toBe('IPv6 nativo');
});

/** Por classificar não é um modo — é a ausência de um, e diz-se com vazio. */
test('an unregistered mode has no label and requires nothing', () => {
  for (const value of [null, undefined, '', '   ']) {
    expect(labelForWanMode(value)).toBe('');
    expect(shortLabelForWanMode(value)).toBe('');
    expect(wanModeRequiresIp(value)).toBe(false);
    expect(isKnownWanMode(value)).toBe(false);
  }
});

test('labels every predefined mode, long and short', () => {
  for (const mode of WAN_MODES) {
    expect(labelForWanMode(mode)).not.toBe('');
    expect(shortLabelForWanMode(mode)).not.toBe('');
  }
  expect(labelForWanMode('PPPoE')).toBe('PPPoE');
  expect(shortLabelForWanMode('pppoe_static')).toBe('PPPoE+IP');
});

/**
 * O SQL que conta atenções em bloco e os nós que o mapa desenha têm de dizer o
 * mesmo. Estes literais entram no meio de subconsultas já parametrizadas.
 */
test('the SQL literal list matches the behavioural list', () => {
  expect(WAN_MODES_REQUIRING_IP_SQL).toBe("'static', 'pppoe_static'");
});

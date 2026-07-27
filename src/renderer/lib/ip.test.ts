import { describe, expect, test } from 'vitest';
import { suggestIpPrefix } from './ip';

describe('suggestIpPrefix', () => {
  test('falls back to 192.168.1. without usable data', () => {
    expect(suggestIpPrefix([])).toBe('192.168.1.');
    expect(suggestIpPrefix([null, '', undefined])).toBe('192.168.1.');
  });

  test('picks the most used /24', () => {
    expect(suggestIpPrefix(['10.20.30.5', '10.20.30.6', '192.168.1.9'])).toBe('10.20.30.');
  });

  test('reads comma-joined deviceIps strings', () => {
    expect(suggestIpPrefix(['10.0.5.1, 10.0.5.2', null, '10.0.5.3'])).toBe('10.0.5.');
  });

  test('still derives a prefix from a malformed last octet', () => {
    expect(suggestIpPrefix(['192.168.44.X'])).toBe('192.168.44.');
  });

  test('ignores entries that are not dotted quads', () => {
    expect(suggestIpPrefix(['sem-ip', '10.0.0', '999.1.1.1'])).toBe('192.168.1.');
  });
});

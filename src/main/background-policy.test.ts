import { describe, expect, it } from 'vitest';
import { parseBackgroundChange, shouldHideOnClose, shouldStartHidden } from './background-policy';

describe('background lifecycle', () => {
  it('keeps jobs alive only with an accessible tray and an enabled preference', () => {
    expect(shouldHideOnClose(true, true, false)).toBe(true);
    expect(shouldHideOnClose(false, true, false)).toBe(false);
    expect(shouldHideOnClose(true, false, false)).toBe(false);
  });
  it('does not prevent explicit quit, update installation or Windows shutdown', () => {
    expect(shouldHideOnClose(true, true, true)).toBe(false);
  });
  it('starts hidden only when explicitly requested in a recoverable packaged app', () => {
    expect(shouldStartHidden(['--hidden'], true, true)).toBe(true);
    expect(shouldStartHidden([], true, true)).toBe(false);
    expect(shouldStartHidden(['--hidden'], false, true)).toBe(false);
    expect(shouldStartHidden(['--hidden'], true, false)).toBe(false);
  });
  it('rejects untrusted IPC payloads instead of coercing them', () => {
    for (const value of [null, [], true, {}, { keepRunning: 'false' }, { openAtLogin: 1 },
      { keepRunning: true, openAtLogin: true }, { path: 'other.exe' }]) {
      expect(() => parseBackgroundChange(value)).toThrow();
    }
    expect(parseBackgroundChange({ keepRunning: false })).toEqual({ keepRunning: false });
    expect(parseBackgroundChange({ openAtLogin: true })).toEqual({ openAtLogin: true });
  });
});

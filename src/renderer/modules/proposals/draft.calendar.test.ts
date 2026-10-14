// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('proposal validity uses the local calendar', () => {
  it.each([
    ['Atlantic/Cape_Verde', 23, 30],
    ['Pacific/Kiritimati', 0, 30],
    ['UTC', 23, 30],
  ] as const)('expires thirty local days after creation in %s at %i:%i', (timezone, hour, minute) => {
    // Start a fresh Node process so TZ applies on Windows and in Vitest workers.
    const result = execFileSync(process.execPath, [
      '--require', 'tsx/cjs', '-e',
      `const {newDraft} = require('./src/renderer/modules/proposals/draft.ts');
       process.stdout.write(newDraft(undefined, new Date(2026, 9, 13, ${hour}, ${minute})).validUntil);`,
    ], { encoding: 'utf8', env: { ...process.env, TZ: timezone } });
    expect(result).toBe('2026-11-12');
  });
});

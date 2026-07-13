import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

function declarations(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  return match?.[1] ?? '';
}

describe('SMS report card styles', () => {
  test('uses a balanced component-responsive layout', () => {
    expect(declarations('.sms-delivery-report')).toMatch(
      /container-type:\s*inline-size/
    );
    expect(declarations('.sms-delivery-report-head')).toMatch(
      /justify-content:\s*space-between/
    );
    expect(declarations('.sms-queue')).toMatch(/display:\s*grid/);
    expect(declarations('.sms-queue')).toMatch(
      /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(styles).toContain('@container (max-width: 32rem)');
    expect(styles).toContain('@container (max-width: 22rem)');
  });

  test('keeps hierarchy and semantic color restrained', () => {
    expect(declarations('.sms-delivery-report h3')).toMatch(
      /color:\s*var\(--text\)/
    );
    expect(declarations('.sms-queue-stat-value')).toMatch(
      /font-size:\s*var\(--fs-xl\)/
    );
    expect(declarations('.sms-queue-stat-label')).toMatch(
      /font-weight:\s*600/
    );
    expect(styles).toContain(
      ".sms-queue-stat[data-tone='success'] .sms-queue-stat-value"
    );
    expect(styles).toContain(
      ".sms-queue-stat[data-tone='danger'] .sms-queue-stat-value"
    );
  });
});

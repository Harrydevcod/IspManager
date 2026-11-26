import { describe, expect, it } from 'vitest';
import { apiUrl } from './api';

describe('apiUrl', () => {
  it('uses the desktop backend for paths and preserves query strings', () => {
    expect(apiUrl('/api/clients?active=1')).toBe('http://127.0.0.1:3001/api/clients?active=1');
    expect(apiUrl('/health')).toBe('http://127.0.0.1:3001/health');
  });
});

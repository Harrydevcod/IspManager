/** Address of the local desktop backend. */
const API_BASE = 'http://127.0.0.1:3001';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

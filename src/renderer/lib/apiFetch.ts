import { apiUrl } from './api';

export type ApiTransport = (input: string, init?: RequestInit) => Promise<Response>;
let transport: ApiTransport | null = null;

export function setApiTransport(next: ApiTransport | null): void { transport = next; }
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (transport) {
    let isBackend = false;
    try {
      isBackend = new URL(input).origin === new URL(apiUrl('')).origin;
    } catch {
      // Relative and malformed addresses stay with the browser's fetch.
    }
    if (isBackend) return transport(input, init);
  }
  return fetch(input, init);
}

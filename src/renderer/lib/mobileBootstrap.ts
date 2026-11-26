import { setApiTransport } from './apiFetch';
import { createMobileTransport } from './mobileTransport';

export const MOBILE_ORIGIN = 'https://appassets.androidplatform.net';
export type MobileBridge = {postMessage(message: string): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void};

export function initializeMobileTransport(origin: string, bridge: MobileBridge | undefined): () => void {
  if (origin !== MOBILE_ORIGIN) return () => {};
  if (!bridge || typeof bridge.postMessage !== 'function' || typeof bridge.addEventListener !== 'function' || typeof bridge.removeEventListener !== 'function') {
    setApiTransport(async () => { throw new Error('Ligação móvel indisponível'); });
    return () => {};
  }
  const transport = createMobileTransport(message => bridge.postMessage(message), callback => {
    const listener = (event: MessageEvent) => { if (typeof event.data === 'string') callback(event.data); };
    bridge.addEventListener('message', listener);
    return () => bridge.removeEventListener('message', listener);
  });
  setApiTransport(transport.fetch);
  return () => transport.close();
}

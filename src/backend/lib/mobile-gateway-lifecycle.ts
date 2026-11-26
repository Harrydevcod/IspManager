import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

type Prepared = { server: Server; publish: (host: string, port: number) => Promise<void> };
type Options = { allowedAddress: (host: string) => boolean; prepare: () => Promise<Prepared> };

type InterfaceAddress = {address: string; family: string; internal: boolean};
export function isMobileListenAddress(host: string, entries: InterfaceAddress[] = Object.values(networkInterfaces()).flatMap(value => value ?? [])): boolean {
  if (isIP(host) !== 4 || host === '0.0.0.0' || host.startsWith('127.')) return false;
  const first = Number(host.split('.')[0]);
  if (first < 1 || first > 223) return false;
  return entries.some(item => item.family === 'IPv4' && !item.internal && item.address === host);
}

/** Explicit, process-local activation; stop also closes active connections. */
export class MobileGatewayLifecycle {
  private serial: Promise<void> = Promise.resolve();
  private generation = 0;
  private active: {server: Server; sockets: Set<Socket>} | null = null;
  private endpoint: {host: string; port: number} | null = null;

  constructor(private readonly options: Options) {}

  status(): {running: boolean; host: string | null; port: number | null} {
    return {running: this.endpoint !== null, host: this.endpoint?.host ?? null, port: this.endpoint?.port ?? null};
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  start(host: string, port: number): Promise<{host: string; port: number}> {
    const requestedGeneration = this.generation;
    return this.enqueue(async () => {
      const checkCancelled = () => { if (requestedGeneration !== this.generation) throw new Error('MOBILE_GATEWAY_CANCELLED'); };
      checkCancelled();
      if (this.active) throw new Error('MOBILE_GATEWAY_ALREADY_RUNNING');
      if (!this.options.allowedAddress(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MOBILE_GATEWAY_ADDRESS_INVALID');
      const prepared = await this.options.prepare();
      checkCancelled();
      const sockets = new Set<Socket>();
      prepared.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      this.active = {server: prepared.server, sockets};
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => { prepared.server.off('listening', onListening); reject(error); };
          const onListening = () => {
            prepared.server.off('error', onError);
            prepared.server.on('error', () => {
              if (this.active?.server === prepared.server) void this.stop().catch(() => undefined);
            });
            resolve();
          };
          prepared.server.once('error', onError);
          prepared.server.once('listening', onListening);
          prepared.server.listen(port, host);
        });
        checkCancelled();
        const address = prepared.server.address();
        if (!address || typeof address === 'string') throw new Error('MOBILE_GATEWAY_ADDRESS_INVALID');
        await prepared.publish(host, address.port);
        checkCancelled();
        this.endpoint = {host, port: address.port};
        return this.endpoint;
      } catch (error) {
        await this.closeActive();
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    this.generation++;
    const closing = this.closeActive();
    return this.enqueue(async () => { await closing; await this.closeActive(); });
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.endpoint = null;
    if (!active) return;
    this.active = null;
    for (const socket of active.sockets) socket.destroy();
    if (active.server.listening) await new Promise<void>((resolve, reject) => active.server.close(error => error ? reject(error) : resolve()));
  }
}

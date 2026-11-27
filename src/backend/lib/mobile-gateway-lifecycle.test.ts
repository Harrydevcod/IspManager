import { createServer } from 'node:http';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MobileGatewayLifecycle, isMobileListenAddress, mobileListenAddresses } from './mobile-gateway-lifecycle';

describe('mobile gateway lifecycle', () => {
  it('starts only on request, publishes after binding, and stops listening', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    let published = false;
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server, publish: async (_host, port) => { expect(port).toBeGreaterThan(0); published = true; }})});
    expect(server.listening).toBe(false);
    const address = await lifecycle.start('127.0.0.1', 0);
    expect(address.port).toBeGreaterThan(0);
    expect(published).toBe(true);
    expect(server.listening).toBe(true);
    await lifecycle.stop();
    expect(server.listening).toBe(false);
  });

  it('closes the listener when publication fails', async () => {
    const server = createServer();
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server, publish: async () => { throw new Error('phone offline'); }})});
    await expect(lifecycle.start('127.0.0.1', 0)).rejects.toThrow('phone offline');
    expect(server.listening).toBe(false);
  });

  it('does not leave a listener open when stopped while preparing', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const server = createServer();
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => { entered(); await gate; return {server, publish: async () => { throw new Error('unexpected publish'); }}; }});
    const starting = lifecycle.start('127.0.0.1', 0);
    await preparing;
    const stopping = lifecycle.stop();
    resume();
    await expect(starting).rejects.toThrow('MOBILE_GATEWAY_CANCELLED');
    await stopping;
    expect(server.listening).toBe(false);
  });

  it('rejects addresses that are not eligible local interfaces', async () => {
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => false, prepare: async () => { throw new Error('unexpected prepare'); }});
    await expect(lifecycle.start('0.0.0.0', 1234)).rejects.toThrow('MOBILE_GATEWAY_ADDRESS_INVALID');
  });

  it('lists only private LAN interfaces the phone can reach, with their names', () => {
    const v4 = (address: string, internal = false) => ({address, family:'IPv4', internal});
    const interfaces = {
      'Wi-Fi': [v4('192.168.1.8'), {address:'2001:db8::1', family:'IPv6', internal:false}],
      'Ethernet': [v4('10.0.0.5')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      'vEthernet (WSL)': [v4('172.20.16.1')],
      'Tailscale': [v4('100.71.9.49')],
      'Público': [v4('41.221.1.2')]
    };
    expect(mobileListenAddresses(interfaces)).toEqual([{address:'192.168.1.8', name:'Wi-Fi'}, {address:'10.0.0.5', name:'Ethernet'}]);
    expect(isMobileListenAddress('192.168.1.8', interfaces)).toBe(true);
    for (const host of ['0.0.0.0', '127.0.0.1', '192.168.1.9', '2001:db8::1', '172.20.16.1', '100.71.9.49', '41.221.1.2']) {
      expect(isMobileListenAddress(host, interfaces)).toBe(false);
    }
  });

  it('closes existing sockets on stop', async () => {
    const server = createServer();
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server, publish: async () => {}})});
    const address = await lifecycle.start('127.0.0.1', 0);
    const client = connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
    await lifecycle.stop();
    await closed;
    expect(server.listening).toBe(false);
  });

  it('clears the running state and closes the listener on server error', async () => {
    const server = createServer();
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server, publish: async () => {}})});
    await lifecycle.start('127.0.0.1', 0);
    const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
    server.emit('error', new Error('listener failed'));
    await closed;
    expect(lifecycle.status().running).toBe(false);
    expect(server.listening).toBe(false);
  });

  it('does not stop a replacement listener when a previously stopped server emits an error', async () => {
    const first = createServer();
    const second = createServer();
    let next = first;
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server: next, publish: async () => {}})});
    await lifecycle.start('127.0.0.1', 0);
    await lifecycle.stop();
    next = second;
    await lifecycle.start('127.0.0.1', 0);
    first.emit('error', new Error('late error'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lifecycle.status().running).toBe(true);
    expect(second.listening).toBe(true);
    await lifecycle.stop();
  });

  it('cancels activation if stopped while awaiting the phone confirmation', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const server = createServer();
    const lifecycle = new MobileGatewayLifecycle({allowedAddress: () => true, prepare: async () => ({server, publish: async () => { entered(); await gate; }})});
    const starting = lifecycle.start('127.0.0.1', 0);
    await publishing;
    const stopping = lifecycle.stop();
    expect(server.listening).toBe(false);
    resume();
    await expect(starting).rejects.toThrow('MOBILE_GATEWAY_CANCELLED');
    await stopping;
    expect(server.listening).toBe(false);
  });
});

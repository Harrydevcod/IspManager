import type { IptvSource } from './iptv-source';
import { isMacAddress, normalizeMacAddress } from '../../shared/mac';
import type { RouterActive, RouterArpEntry, RouterDhcpLease } from './routeros';

type Lease = Pick<RouterDhcpLease, 'address' | 'macAddress'>;
type Arp = Pick<RouterArpEntry, 'address' | 'macAddress'>;
type Session = Pick<RouterActive, 'name' | 'address'>;
export type IptvValidation =
  | { state: 'ok'; address: string | null; via: 'pppoe' | 'legacy' }
  | { state: 'warning'; reason: string }
  | { state: 'not_found' }
  | { state: 'missing'; reason: string };

const canon = (value: string | null | undefined) => {
  const mac = normalizeMacAddress(value);
  return mac && isMacAddress(mac) ? mac : null;
};
const same = (a: string | null | undefined, b: string | null | undefined) => {
  const left = canon(a);
  return left !== null && left === canon(b);
};

/**
 * Prova a origem escolhida contra o que o router vê (sessões, leases e ARP). Pura: as leituras vêm de fora.
 * Uma lease conta em qualquer estado (`waiting` também): aqui só interessa que o MAC existe na rede.
 * PPPoE prova-se pela sessão; sem ela, pelo MAC legacy; sem nenhum dos dois o cliente está desligado
 * (`not_found`) e nunca se avisa de WDS.
 */
export function validateIptvSource(target: IptvSource, seen: { antennaMac: string | null; sessions: Session[]; leases: Lease[]; arp: Arp[] }): IptvValidation {
  if (target.kind === 'missing') return { state: 'missing', reason: target.reason };
  const rows = [...seen.leases, ...seen.arp];
  if (target.kind === 'pppoe') {
    const session = seen.sessions.find((s) => s.name === target.username);
    if (session) return { state: 'ok', address: session.address, via: 'pppoe' };
    const legacy = target.legacy;
    const hit = legacy && rows.find((row) => same(row.macAddress, legacy.mac));
    return hit ? { state: 'ok', address: hit.address, via: 'legacy' } : { state: 'not_found' };
  }
  const hit = rows.find((row) => same(row.macAddress, target.mac));
  if (hit) return { state: 'ok', address: hit.address, via: 'legacy' };
  // MAC-NAT: a antena aparece em vários endereços (um por aparelho atrás dela). Num só, é o IP de gestão e é normal.
  const antennaAddresses = new Set(rows.filter((row) => same(row.macAddress, seen.antennaMac)).map((row) => row.address));
  return target.via !== 'antena' && antennaAddresses.size >= 2
    ? { state: 'warning', reason: 'O router vê o MAC da antena: WDS desligado ou modo mal registado' }
    : { state: 'not_found' };
}

const toRange = (cidr: string): [number, number] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) return null;
  const ip = m.slice(1, 5).reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(m[5]));
  const start = ip - (ip % size);
  return [start, start + size - 1];
};

/**
 * A primeira gama do router que se sobrepõe à LAN do cliente, ou null. As gamas vêm de
 * `/ip/address` (endereço de interface, `192.168.1.1/24`); quem chama já tirou as desactivadas.
 */
export function cidrOverlaps(lan: string, routerAddresses: string[]): string | null {
  const a = toRange(lan);
  if (!a) return null;
  return routerAddresses.find((cidr) => { const b = toRange(cidr); return b !== null && a[0] <= b[1] && b[0] <= a[1]; }) ?? null;
}

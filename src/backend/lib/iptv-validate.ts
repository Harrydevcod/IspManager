import type { IptvSource } from './iptv-source';
import { normalizeMacAddress } from '../../shared/mac';

type Lease = { address: string; macAddress: string | null };
type Arp = { address: string; macAddress: string | null };
export type IptvValidation = { state: 'ok'; address: string | null } | { state: 'warning'; reason: string } | { state: 'not_found' } | { state: 'missing'; reason: string };

const same = (a: string | null | undefined, b: string | null | undefined) => {
  const left = normalizeMacAddress(a);
  return left !== null && left === normalizeMacAddress(b);
};

/**
 * Prova a origem escolhida contra o que o router vê (leases e ARP). Pura: as leituras vêm de fora.
 * Uma lease conta em qualquer estado (`waiting` também): aqui só interessa que o MAC existe na rede.
 */
export function validateIptvSource(target: IptvSource, seen: { antennaMac: string | null; leases: Lease[]; arp: Arp[] }): IptvValidation {
  if (target.kind === 'missing') return { state: 'missing', reason: target.reason };
  // Em migração valida-se o MAC legacy que ainda conta; sem ele, o PPPoE não tem MAC a provar.
  if (target.kind === 'pppoe' && !target.legacy) return { state: 'ok', address: null };
  const source = target.kind === 'pppoe' ? { kind: 'mac' as const, ...(target.legacy as NonNullable<typeof target.legacy>) } : target;
  const hit = seen.leases.find((l) => same(l.macAddress, source.mac)) ?? seen.arp.find((a) => same(a.macAddress, source.mac));
  if (hit) return { state: 'ok', address: hit.address };
  const antennaSeen = source.via !== 'antena' && [...seen.leases, ...seen.arp].some((row) => same(row.macAddress, seen.antennaMac));
  return antennaSeen ? { state: 'warning', reason: 'O router vê o MAC da antena: WDS desligado ou modo mal registado' } : { state: 'not_found' };
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

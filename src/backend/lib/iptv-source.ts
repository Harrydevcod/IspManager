import { isMacAddress, normalizeMacAddress } from '../../shared/mac';

/** Um equipamento activo do serviço, como a regra o precisa de ver. */
export type IptvDevice = { type: string | null; operationMode: string | null; macAddress: string | null };

export type IptvLegacy = { mac: string; via: 'antena' | 'router' | 'aparelho' };
export type IptvSource =
  /** `legacy` é o MAC que o cliente ainda usa enquanto não migra; o script segue os dois. */
  | { kind: 'pppoe'; username: string; legacy: IptvLegacy | null }
  | ({ kind: 'mac' } & IptvLegacy)
  | { kind: 'missing'; reason: string };

/** Modos em que a antena faz NAT: o gateway só vê o MAC dela. */
const NAT_ANTENNA = new Set(['router', 'wisp']);
const LAYER2_ROUTER = new Set(['ap', 'ponte']);
const ANTENNA_TYPES = new Set(['cpe', 'antena']);

const kind = (device: IptvDevice) => (device.type ?? '').trim().toLowerCase();
const mac = (device: IptvDevice | undefined) => {
  const value = normalizeMacAddress(device?.macAddress);
  return value && isMacAddress(value) ? value : null;
};

/**
 * Que identificadores do serviço o script do router segue (ADR 0021). O MAC legacy é o
 * que o gateway vê: o da antena se ela faz NAT, senão o do router do cliente, e com tudo
 * em camada 2 o do aparelho IPTV. Com utilizador PPPoE leva os dois: o ISPM dá utilizador
 * a todos os serviços muito antes de o cliente migrar, e o script só casa o que existe
 * no router (sessão activa ou lease `bound`). Depois da migração a lease expira e o MAC
 * deixa de casar sozinho. Um modo por classificar nunca se adivinha.
 */
export function iptvSource(service: { pppoeUsername: string | null }, devices: IptvDevice[]): IptvSource {
  const legacy = legacySource(devices);
  const username = service.pppoeUsername?.trim();
  if (username) return { kind: 'pppoe', username, legacy: legacy.kind === 'mac' ? { mac: legacy.mac, via: legacy.via } : null };
  return legacy;
}

function legacySource(devices: IptvDevice[]): Exclude<IptvSource, { kind: 'pppoe' }> {
  const antenna = devices.find((device) => ANTENNA_TYPES.has(kind(device)));
  if (!antenna) return { kind: 'missing', reason: 'Sem antena registada no serviço' };
  if (!antenna.operationMode) return { kind: 'missing', reason: 'Modo da antena por classificar' };
  if (NAT_ANTENNA.has(antenna.operationMode)) {
    const found = mac(antenna);
    return found ? { kind: 'mac', mac: found, via: 'antena' } : { kind: 'missing', reason: 'Falta o MAC da antena' };
  }

  const router = devices.find((device) => kind(device) === 'router');
  if (router && !router.operationMode) return { kind: 'missing', reason: 'Modo do router do cliente por classificar' };
  if (router && !LAYER2_ROUTER.has(router.operationMode as string)) {
    const found = mac(router);
    return found ? { kind: 'mac', mac: found, via: 'router' } : { kind: 'missing', reason: 'Falta o MAC do router do cliente' };
  }

  const appliance = devices.find((device) => !ANTENNA_TYPES.has(kind(device)) && kind(device) !== 'router' && mac(device));
  const found = mac(appliance);
  return found ? { kind: 'mac', mac: found, via: 'aparelho' } : { kind: 'missing', reason: 'Falta o MAC do aparelho IPTV (TV ou box)' };
}

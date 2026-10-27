import { EQUIPMENT_TYPES } from '../../shared/equipment';
import { isKnownOperationMode } from '../../shared/operation';
import { isMacAddress, normalizeMacAddress } from '../../shared/mac';

/** Um equipamento activo do serviço, como a regra o precisa de ver. */
export type IptvDevice = { type: string | null; operationMode: string | null; macAddress: string | null };

export type IptvLegacy = { mac: string; via: 'antena' | 'router' | 'aparelho' };
export type IptvSource =
  /** `legacy` é o MAC que o cliente ainda usa enquanto não migra; o script segue os dois. */
  | { kind: 'pppoe'; username: string; legacy: IptvLegacy | null }
  | ({ kind: 'mac' } & IptvLegacy)
  | { kind: 'missing'; reason: string };

/** Modos em que o equipamento faz NAT: o gateway só vê o MAC dele. */
const NAT_MODES = new Set(['router', 'wisp']);
const ANTENNA_LAYER2 = new Set(['cliente', 'ponte', 'ap', 'repetidor', 'mesh']);
const ROUTER_LAYER2 = new Set(['ap', 'ponte', 'repetidor', 'mesh']);
export const ANTENNA_TYPES = new Set(['cpe', 'antena']);
/** Tudo o que o catálogo conhece, menos `outro`: nunca é o aparelho IPTV. O texto livre (`tv`, `box`) pode ser. */
const NOT_APPLIANCE = new Set<string>(EQUIPMENT_TYPES.filter((t) => t !== 'outro'));

const kind = (device: IptvDevice) => (device.type ?? '').trim().toLowerCase();
const modeOf = (device: IptvDevice) => (device.operationMode ?? '').trim().toLowerCase();
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
  const router = devices.find((device) => kind(device) === 'router');
  if (!antenna && !router) return { kind: 'missing', reason: 'Sem antena nem router registados no serviço' };

  if (antenna) {
    const mode = modeOf(antenna);
    if (!mode) return { kind: 'missing', reason: 'Modo da antena por classificar' };
    if (NAT_MODES.has(mode)) {
      const found = mac(antenna);
      return found ? { kind: 'mac', mac: found, via: 'antena' } : { kind: 'missing', reason: 'Falta o MAC da antena' };
    }
    if (!ANTENNA_LAYER2.has(mode)) {
      return { kind: 'missing', reason: isKnownOperationMode(mode) ? `Modo ${mode} sem regra para a antena` : `Modo da antena desconhecido: ${mode}` };
    }
  }

  if (router) {
    const mode = modeOf(router);
    if (!mode) return { kind: 'missing', reason: 'Modo do router do cliente por classificar' };
    if (NAT_MODES.has(mode)) {
      const found = mac(router);
      return found ? { kind: 'mac', mac: found, via: 'router' } : { kind: 'missing', reason: 'Falta o MAC do router do cliente' };
    }
    if (!ROUTER_LAYER2.has(mode)) {
      return { kind: 'missing', reason: isKnownOperationMode(mode) ? `Modo ${mode} sem regra para o router do cliente` : `Modo do router do cliente desconhecido: ${mode}` };
    }
  }

  const found = mac(devices.find((device) => !NOT_APPLIANCE.has(kind(device)) && mac(device)));
  return found ? { kind: 'mac', mac: found, via: 'aparelho' } : { kind: 'missing', reason: 'Falta o MAC do aparelho IPTV (TV ou box)' };
}

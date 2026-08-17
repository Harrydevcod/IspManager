import { ipToInt } from '../../shared/ip-range';
import { vendorForMac, type RegisteredIp, type SeenHostRow } from './network-discovery';

/**
 * O cruzamento entre o que está na rede e o que o ISPM diz que lá devia estar.
 *
 * É esta função que justifica a ferramenta existir dentro do ERP: varrer IPs
 * qualquer scanner faz, mas só aqui se sabe que o `192.168.1.42` é o CPE do
 * Sr. Silva, que o `.51` está atribuído a dois serviços ao mesmo tempo, e que
 * o `.87` é o próximo endereço livre para a instalação de amanhã.
 *
 * Pura de propósito: recebe linhas já lidas e devolve o relatório, para os
 * testes cobrirem as cinco categorias sem levantar base de dados nenhuma.
 */

export type DiscoveryCategory = 'desconhecido' | 'registado' | 'ausente' | 'reservado' | 'duplicado';

export type RegisteredRef = { kind: 'backbone' | 'assignment'; id: number; name: string; active: boolean };

export type DiscoveryRow = {
  ip: string;
  mac: string | null;
  hostname: string | null;
  vendor: string | null;
  category: DiscoveryCategory;
  alive: boolean;
  rttMs: number | null;
  source: string | null;
  registeredAs: RegisteredRef[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type DiscoveryReport = {
  rows: DiscoveryRow[];
  counts: Record<DiscoveryCategory | 'livre', number>;
  freeIps: string[];
  nextFreeIp: string | null;
  registeredIps: string[];
  /**
   * Quantos endereços foram varridos. Zero significa "ainda não se perguntou",
   * que não é a mesma coisa que "não há nada livre" — sem isto a interface não
   * consegue distinguir os dois e mostra um zero que é mentira.
   */
  rangeSize: number;
};

export type ObservedHost = {
  ip: string;
  mac: string | null;
  hostname: string | null;
  source: 'ping' | 'arp' | 'router';
  rttMs: number | null;
};

export type CrossRefInput = {
  /** Endereços do intervalo varrido. Vazio quando ainda ninguém varreu. */
  rangeIps: string[];
  /** O que respondeu ou foi visto agora, já fundido das três fontes. */
  observed: ObservedHost[];
  registered: RegisteredIp[];
  seen: SeenHostRow[];
};

function byIpOrder(a: string, b: string): number {
  return (ipToInt(a) ?? 0) - (ipToInt(b) ?? 0);
}

export function crossReference(input: CrossRefInput): DiscoveryReport {
  const observedByIp = new Map(input.observed.map((host) => [host.ip, host]));
  const seenByIp = new Map(input.seen.map((row) => [row.ipAddress, row]));
  const rangeSet = new Set(input.rangeIps);

  const registeredByIp = new Map<string, RegisteredRef[]>();
  for (const entry of input.registered) {
    const list = registeredByIp.get(entry.ip) ?? [];
    list.push({ kind: entry.kind, id: entry.id, name: entry.name, active: entry.active });
    registeredByIp.set(entry.ip, list);
  }

  // Universo de linhas: tudo o que foi observado, tudo o que está registado
  // dentro do intervalo varrido, e os duplicados (que são verdade sobre a base
  // de dados, com ou sem varrimento — daí não dependerem do intervalo).
  const candidates = new Set<string>(observedByIp.keys());
  for (const [ip, refs] of registeredByIp) {
    if (refs.length > 1 || rangeSet.has(ip)) candidates.add(ip);
  }

  const rows: DiscoveryRow[] = [];
  for (const ip of [...candidates].sort(byIpOrder)) {
    const observed = observedByIp.get(ip) ?? null;
    const history = seenByIp.get(ip) ?? null;
    const refs = registeredByIp.get(ip) ?? [];
    const mac = observed?.mac ?? history?.macAddress ?? null;

    // Ordem deliberada: o duplicado tapa tudo o resto porque é o único que é
    // sempre um erro de dados a corrigir; e um IP vivo sem dono é o achado.
    //
    // Quem não responde separa-se em dois: `ausente` é avaria — alguém que
    // devia estar de pé e não está; `reservado` é o CPE do cliente cortado,
    // que está em baixo de propósito e continua a ocupar o endereço.
    const category: DiscoveryCategory =
      refs.length > 1 ? 'duplicado'
        : observed ? (refs.length === 0 ? 'desconhecido' : 'registado')
          : refs.some((ref) => ref.active) ? 'ausente' : 'reservado';

    rows.push({
      ip,
      mac,
      hostname: observed?.hostname ?? history?.hostname ?? null,
      vendor: vendorForMac(mac) ?? history?.vendor ?? null,
      category,
      alive: observed !== null,
      rttMs: observed?.rttMs ?? null,
      source: observed?.source ?? history?.source ?? null,
      registeredAs: refs,
      firstSeenAt: history?.firstSeenAt ?? null,
      lastSeenAt: history?.lastSeenAt ?? null
    });
  }

  // Livre = dentro do intervalo varrido, sem registo e sem resposta. Fora de um
  // varrimento não há endereços livres a declarar: "ninguém respondeu" só
  // significa alguma coisa depois de se ter perguntado.
  const freeIps = input.rangeIps
    .filter((ip) => !observedByIp.has(ip) && !registeredByIp.has(ip))
    .sort(byIpOrder);

  const counts = { desconhecido: 0, registado: 0, ausente: 0, reservado: 0, duplicado: 0, livre: freeIps.length };
  for (const row of rows) counts[row.category] += 1;

  return {
    rows,
    counts,
    freeIps,
    nextFreeIp: freeIps[0] ?? null,
    registeredIps: [...registeredByIp.keys()],
    rangeSize: rangeSet.size
  };
}

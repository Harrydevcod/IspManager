import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import type Database from 'better-sqlite3';
import { mapWithLimit, systemPing, type Pinger } from './network-probe';
import { ouiTable } from './oui-data';

/**
 * Descoberta de equipamentos na rede — o varrimento e o cruzamento com o que o
 * ISPM já sabe.
 *
 * A sonda (`network-probe.ts`) pergunta "os equipamentos que eu conheço estão de
 * pé?". Isto pergunta o inverso: "o que está na rede que eu não conheço?". Daí
 * partilharem o ping e o pool de concorrência mas nada mais: a sonda corre
 * sozinha para sempre e é discreta; isto é um botão e quer despachar-se.
 */

// ponytail: 32 em voo com 1 s de timeout varre um /24 em ~8 s sem afogar o
// portátil de quem clicou. A sonda periódica usa 8/1500 porque nunca pára.
const SWEEP_CONCURRENCY = 32;
const SWEEP_TIMEOUT_MS = 1000;

/** DNS inverso: 300 ms e uma tentativa. Quem não responde já, não responde. */
const DNS_TIMEOUT_MS = 300;

/** Ao fim de 90 dias sem ser visto, o registo deixa de dizer alguma coisa. */
const KEEP_HOSTS_DAYS = 90;

export type SweepResult = { ip: string; ok: boolean; rttMs: number | null };

// ------------------------------------------------------------------ varrimento

export async function sweep(
  ips: string[],
  options: { ping?: Pinger; concurrency?: number; timeoutMs?: number } = {}
): Promise<SweepResult[]> {
  const ping = options.ping ?? systemPing;
  const timeoutMs = options.timeoutMs ?? SWEEP_TIMEOUT_MS;
  return mapWithLimit(ips, options.concurrency ?? SWEEP_CONCURRENCY, async (ip) => {
    const result = await ping(ip, timeoutMs);
    return { ip, ok: result.ok, rttMs: result.rttMs };
  });
}

// ------------------------------------------------------------------------ ARP

const MAC_SEPARATED = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
const IPV4_IN_TEXT = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = MAC_SEPARATED.exec(raw);
  if (!match) return null;
  const mac = match[0].replace(/-/g, ':').toUpperCase();
  // Broadcast e multicast não são equipamentos — são endereços de grupo, e
  // apareceriam em todas as tabelas ARP de todas as redes.
  if (mac === 'FF:FF:FF:FF:FF:FF') return null;
  if ((Number.parseInt(mac.slice(0, 2), 16) & 1) === 1) return null;
  return mac;
}

function isMulticastOrBroadcastIp(ip: string): boolean {
  const first = Number(ip.split('.')[0]);
  // 224.0.0.0/4 (multicast) e 255.x (broadcast). O 239.255.255.250 do SSDP
  // aparece em praticamente todas as tabelas ARP do Windows.
  return first >= 224;
}

/**
 * Lê a tabela ARP a partir do stdout do `arp -a`.
 *
 * **Casa linha a linha por padrão, nunca por cabeçalho.** O `arp -a` do Windows
 * em português escreve "Endereço Internet / Endereço Físico / Tipo", em inglês
 * "Internet Address / Physical Address / Type", e o do Linux nem cabeçalho tem.
 * Um parser que dependa da coluna certa falha em silêncio — devolve zero MACs e
 * ninguém percebe porquê, porque a página continua a funcionar sem eles.
 */
export function parseArpTable(stdout: string): Array<{ ip: string; mac: string }> {
  const found = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const ipMatch = IPV4_IN_TEXT.exec(line);
    if (!ipMatch) continue;
    const mac = normalizeMac(line);
    if (!mac) continue;
    const ip = ipMatch[0];
    if (isMulticastOrBroadcastIp(ip)) continue;
    // A linha "Interface: 192.168.1.10 --- 0xd" do Windows tem IP mas não MAC,
    // por isso já saiu acima; o `has` protege de duplicados entre interfaces.
    if (!found.has(ip)) found.set(ip, mac);
  }
  return [...found].map(([ip, mac]) => ({ ip, mac }));
}

export async function readLocalArp(): Promise<Array<{ ip: string; mac: string }>> {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      // Sem tabela ARP a descoberta continua a valer pelo ping; não é motivo
      // para falhar o pedido todo.
      resolve(error && !stdout ? [] : parseArpTable(stdout ?? ''));
    });
  });
}

// --------------------------------------------------------------------- nomes

/**
 * DNS inverso, só sobre os endereços que responderam.
 *
 * `dns.reverse` não aceita timeout e numa LAN sem servidor de nomes local fica
 * pendurado por cada endereço; um `Resolver` próprio com 300 ms e uma tentativa
 * resolve isso sem prender o processo (um `Promise.race` com `setTimeout` sem
 * `unref()` prenderia).
 */
export async function resolveNames(ips: string[]): Promise<Map<string, string>> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const names = new Map<string, string>();
  await mapWithLimit(ips, 16, async (ip) => {
    try {
      const [name] = await resolver.reverse(ip);
      if (name) names.set(ip, name);
    } catch {
      // Sem PTR. É o caso comum numa LAN e não é erro.
    }
  });
  return names;
}

// --------------------------------------------------------------- fabricante

/**
 * Fabricante a partir dos três primeiros octetos do MAC.
 *
 * A tabela é o registo oficial do IEEE, gerado por `scripts/fetch-oui.cjs` e
 * commitado — a aplicação nunca vai à Internet buscá-la. Um mapa escrito à mão
 * foi tentado primeiro e falhou no terreno: numa única leitura da tabela ARP
 * desta rede apareceram 21 prefixos globais distintos e nenhum estava lá, o que
 * deixava a coluna a mostrar "—" em todas as linhas.
 *
 * MACs aleatórios (bit administrado localmente) não têm fabricante nenhum, por
 * definição — são os telemóveis e portáteis modernos, e ficam em branco.
 */
export function vendorForMac(mac: string | null | undefined): string | null {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  return ouiTable().get(normalized.replace(/:/g, '').slice(0, 6)) ?? null;
}

// --------------------------------------------------- registos conhecidos

export type RegisteredIp = {
  ip: string;
  kind: 'backbone' | 'assignment';
  id: number;
  name: string;
  /** `false` = ocupa o endereço mas não se espera que responda (ver abaixo). */
  active: boolean;
};

/**
 * Todos os IPs que o ISPM diz ter na rede. Backbone e equipamento instalado em
 * serviços — as duas colunas onde um IP significa "isto está ocupado".
 *
 * **Ocupado não é o mesmo que ativo.** O CPE de um cliente suspenso continua em
 * casa dele com o mesmo endereço: não responde ao ping porque foi cortado, mas
 * dar esse IP a outra instalação é um conflito no terreno no dia em que ele
 * pagar. O que liberta um endereço é o registo acabar — retirar o equipamento
 * (`end_date`), limpar o IP, abater o backbone — nunca o estado do serviço.
 *
 * Daí o `active`: diz quem devia estar de pé, para o cruzamento separar uma
 * avaria (`ausente`) de um endereço reservado por um serviço parado
 * (`reservado`). A sonda (`network-probe.ts`) é que filtra por serviço ativo,
 * porque a pergunta dela é outra: "quem devia estar a responder?".
 */
export function loadRegisteredIps(db: Database.Database): RegisteredIp[] {
  const backbones = db.prepare(`
    SELECT ip_address AS ip, id, name, status
    FROM backbone_devices
    WHERE status <> 'retired'
      AND ip_address IS NOT NULL AND TRIM(ip_address) <> ''
  `).all() as Array<{ ip: string; id: number; name: string; status: string }>;

  const assignments = db.prepare(`
    SELECT a.ip_address AS ip, a.id, c.full_name AS name, s.status
    FROM service_device_assignments a
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    WHERE a.end_date IS NULL
      AND a.ip_address IS NOT NULL AND TRIM(a.ip_address) <> ''
  `).all() as Array<{ ip: string; id: number; name: string; status: string }>;

  return [
    ...backbones.map((row) => ({
      ip: row.ip.trim(),
      kind: 'backbone' as const,
      id: row.id,
      name: row.name,
      // Em manutenção continua a ser equipamento nosso que devia estar de pé.
      active: row.status === 'active' || row.status === 'maintenance'
    })),
    ...assignments.map((row) => ({
      ip: row.ip.trim(),
      kind: 'assignment' as const,
      id: row.id,
      name: row.name,
      active: row.status === 'active'
    }))
  ];
}

// ---------------------------------------------------------------- histórico

export type DiscoveredHost = {
  ip: string;
  mac: string | null;
  hostname: string | null;
  source: 'ping' | 'arp' | 'router';
};

export type SeenHostRow = {
  ipAddress: string;
  macAddress: string | null;
  hostname: string | null;
  vendor: string | null;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  timesSeen: number;
};

/**
 * Regista o que foi visto e purga o que já não diz nada.
 *
 * O `COALESCE` não é detalhe: um varrimento que apanhe o IP pelo ping mas ainda
 * não tenha o MAC na tabela ARP não pode apagar o MAC que o varrimento anterior
 * já tinha descoberto.
 */
export function persistSeen(db: Database.Database, hosts: DiscoveredHost[]): void {
  if (hosts.length === 0) return;
  const upsert = db.prepare(`
    INSERT INTO network_discovery_hosts (ip_address, mac_address, hostname, vendor, source)
    VALUES (@ip, @mac, @hostname, @vendor, @source)
    ON CONFLICT(ip_address) DO UPDATE SET
      mac_address = COALESCE(excluded.mac_address, mac_address),
      hostname    = COALESCE(excluded.hostname, hostname),
      vendor      = COALESCE(excluded.vendor, vendor),
      source      = excluded.source,
      last_seen_at = CURRENT_TIMESTAMP,
      times_seen  = times_seen + 1
  `);

  db.transaction(() => {
    for (const host of hosts) {
      upsert.run({
        ip: host.ip,
        mac: host.mac,
        hostname: host.hostname,
        vendor: vendorForMac(host.mac),
        source: host.source
      });
    }
    db.prepare(`DELETE FROM network_discovery_hosts WHERE last_seen_at < date('now', ?)`)
      .run(`-${KEEP_HOSTS_DAYS} days`);
  })();
}

export function loadSeenHosts(db: Database.Database): SeenHostRow[] {
  return db.prepare(`
    SELECT ip_address AS ipAddress, mac_address AS macAddress, hostname, vendor, source,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, times_seen AS timesSeen
    FROM network_discovery_hosts
  `).all() as SeenHostRow[];
}

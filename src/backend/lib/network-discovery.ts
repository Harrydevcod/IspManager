import { execFile } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import type Database from 'better-sqlite3';
import { mapWithLimit, systemPing, type Pinger } from './network-probe';
import { ouiTable } from './oui-data';
import { normalizeMacAddress } from '../../shared/mac';

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

export type RegisteredDevice = {
  /** `null` quando o registo ainda não tem endereço — é o caso de quem anda em DHCP. */
  ip: string | null;
  /** Canónico (`AA:BB:CC:...`) ou `null`. É por aqui que se casa quem anda em DHCP. */
  mac: string | null;
  kind: 'backbone' | 'assignment';
  id: number;
  name: string;
  /** `false` = ocupa o endereço mas não se espera que responda (ver abaixo). */
  active: boolean;
  /**
   * Marca e modelo do catálogo, já compostos (`TP-Link CPE710`).
   *
   * Esta é a fonte de modelo mais exata que existe e não custa um único pacote
   * na rede: o equipamento foi registado por alguém que o tinha na mão. Serve
   * de referência para as sondagens — quando o que se descobre na rede não bate
   * certo com isto, o que está errado é o registo, não a descoberta.
   */
  model: string | null;
  /** Para propor o item certo ao registar, e para saber quem é obrigado a ter IP fixo. */
  catalogId: number | null;
  catalogType: string | null;
};

/** `TP-Link` + `CPE710` → `TP-Link CPE710`; qualquer um em falta não estorva. */
function catalogLabel(brand: string | null, model: string | null): string | null {
  const label = [brand, model].map((part) => part?.trim()).filter(Boolean).join(' ');
  return label || null;
}

/**
 * Todo o equipamento que o ISPM diz ter — backbone e o instalado em serviços.
 *
 * Devolve também quem **não tem endereço**: o router do cliente apanha IP por
 * DHCP e há registos por preencher. Quem só quer endereços ocupados (o
 * cruzamento) filtra pelo `ip` vazio; quem quer casar registo com rede (a
 * reconciliação) precisa deles, porque é pelo MAC que se casam.
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
export function loadRegisteredDevices(db: Database.Database): RegisteredDevice[] {
  type Row = {
    ip: string | null; mac: string | null; id: number; name: string; status: string;
    brand: string | null; model: string | null; catalogId: number | null; catalogType: string | null;
  };

  const backbones = db.prepare(`
    SELECT b.ip_address AS ip, b.mac_address AS mac, b.id, b.name, b.status,
           cat.brand, cat.model, cat.id AS catalogId, cat.type AS catalogType
    FROM backbone_devices b
    LEFT JOIN equipment_catalog cat ON cat.id = b.catalog_id
    WHERE b.status <> 'retired'
  `).all() as Row[];

  const assignments = db.prepare(`
    SELECT a.ip_address AS ip, a.mac_address AS mac, a.id, c.full_name AS name, s.status,
           cat.brand, cat.model, cat.id AS catalogId, cat.type AS catalogType
    FROM service_device_assignments a
    JOIN services s ON s.id = a.service_id
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN equipment_catalog cat ON cat.id = a.catalog_id
    WHERE a.end_date IS NULL
  `).all() as Row[];

  return [
    ...backbones.map((row) => ({
      ip: row.ip?.trim() || null,
      mac: normalizeMacAddress(row.mac),
      kind: 'backbone' as const,
      id: row.id,
      name: row.name,
      // Em manutenção continua a ser equipamento nosso que devia estar de pé.
      active: row.status === 'active' || row.status === 'maintenance',
      model: catalogLabel(row.brand, row.model),
      catalogId: row.catalogId,
      catalogType: row.catalogType
    })),
    ...assignments.map((row) => ({
      ip: row.ip?.trim() || null,
      mac: normalizeMacAddress(row.mac),
      kind: 'assignment' as const,
      id: row.id,
      name: row.name,
      active: row.status === 'active',
      model: catalogLabel(row.brand, row.model),
      catalogId: row.catalogId,
      catalogType: row.catalogType
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
  model: string | null;
  modelSource: string | null;
};

/**
 * De onde veio um modelo, por ordem de quanto se pode confiar nele.
 *
 * `snmp` é o aparelho a responder `sysDescr` — diz de si próprio o que é.
 * `router` é o MikroTik de gestão a repetir o que o vizinho anunciou por
 * MNDP/CDP/LLDP: de segunda mão, mas ainda o protocolo a falar.
 * `http` é a leitura do título de uma página de login, que é interpretação de
 * HTML e muda quando o firmware muda de tema.
 *
 * A ordem existe para o palpite nunca apagar o facto: sem ela bastava uma
 * sondagem HTTP a seguir a um SNMP para o modelo exato desaparecer da linha.
 */
export const MODEL_SOURCE_RANK: Record<string, number> = { http: 1, router: 2, snmp: 3 };

export type ModelSource = 'http' | 'router' | 'snmp';

export type ModelFinding = {
  ip: string;
  /**
   * `null` quando o equipamento respondeu mas ninguém soube ler um modelo na
   * resposta. Guarda-se na mesma pelo `detail`: é essa resposta em bruto que
   * permite escrever a regra que falta, em vez de a adivinhar.
   */
  model: string | null;
  source: ModelSource;
  /** Resposta em bruto que originou o modelo, para se poder explicar um erro. */
  detail?: string | null;
};

/**
 * Guarda o modelo descoberto, **se** a fonte nova for pelo menos tão boa como a
 * que lá está. Devolve se chegou a escrever.
 *
 * Fica fora do `persistSeen` de propósito: aquele corre com o range inteiro a
 * cada varrimento e nunca tem modelo nenhum para gravar. Misturar as duas
 * coisas era pôr uma comparação de precedência no caminho quente por nada.
 */
export function persistModel(db: Database.Database, finding: ModelFinding): boolean {
  const current = db
    .prepare(`SELECT model_source AS modelSource FROM network_discovery_hosts WHERE ip_address = ?`)
    .get(finding.ip) as { modelSource: string | null } | undefined;

  const incoming = MODEL_SOURCE_RANK[finding.source] ?? 0;

  // Respondeu, mas sem modelo legível: fica só a prova, e o modelo que lá
  // estiver não se toca — um banner por decifrar não apaga um `sysDescr`.
  if (!finding.model) {
    if (!current || !finding.detail) return false;
    db.prepare(`UPDATE network_discovery_hosts SET model_detail = ? WHERE ip_address = ?`)
      .run(finding.detail, finding.ip);
    return false;
  }

  if (!current) {
    // Um vizinho anunciado pelo router pode ser um endereço que o varrimento
    // nunca tocou — o router encaminha redes que a nossa máquina não vê. Não é
    // motivo para deitar fora o que ele disse, e a linha nasce aqui.
    //
    // As sondagens não têm esta necessidade: só correm sobre endereços que
    // acabaram de ser varridos, portanto a linha já existe. Se não existir, o
    // varrimento seguinte cria-a e a sondagem volta a encontrar o mesmo — não
    // se inventa aqui um avistamento que ninguém registou.
    if (finding.source !== 'router') return false;
    db.prepare(`
      INSERT INTO network_discovery_hosts (ip_address, source, model, model_source, model_detail, model_seen_at)
      VALUES (@ip, 'router', @model, @source, @detail, CURRENT_TIMESTAMP)
    `).run({ ip: finding.ip, model: finding.model, source: finding.source, detail: finding.detail ?? null });
    return true;
  }

  if (incoming < (MODEL_SOURCE_RANK[current.modelSource ?? ''] ?? 0)) return false;

  db.prepare(`
    UPDATE network_discovery_hosts
    SET model = @model, model_source = @source, model_detail = @detail, model_seen_at = CURRENT_TIMESTAMP
    WHERE ip_address = @ip
  `).run({ ip: finding.ip, model: finding.model, source: finding.source, detail: finding.detail ?? null });
  return true;
}

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
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, times_seen AS timesSeen,
           model, model_source AS modelSource
    FROM network_discovery_hosts
  `).all() as SeenHostRow[];
}

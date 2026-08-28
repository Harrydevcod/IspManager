import { normalizeMacAddress } from '../../shared/mac';
import type { RegisteredDevice, SeenHostRow } from './network-discovery';
import { sameModel } from '../../shared/model-match';

/**
 * Casar o que está no registo com o que está na rede, e propor as diferenças.
 *
 * Puro de propósito: recebe linhas já lidas e devolve propostas. Não escreve
 * nada — aplicar é sempre um botão, e o botão chama as rotas de equipamento que
 * já existem, com as validações que elas já têm. A descoberta não abre uma
 * porta paralela ao registo.
 */

/**
 * **Casa-se primeiro pelo MAC.**
 *
 * O IP parecia a chave óbvia e é a que o `fill-macs-from-discovery.cjs` usa,
 * mas só serve para equipamento de endereço fixo. Os routers dos clientes
 * apanham endereço por DHCP na mesma rede dos CPE: desligar e religar um deles
 * troca-lhe o IP, e a partir daí o casamento por endereço passa a apontar para
 * o equipamento errado — ou para nenhum. O MAC é que é identidade.
 */
export type MatchVia = 'mac' | 'ip';

export type Match = { device: RegisteredDevice; host: SeenHostRow; via: MatchVia };

/** O mesmo aparelho visto em dois endereços é história, não ambiguidade. */
function mostRecent(a: SeenHostRow, b: SeenHostRow): SeenHostRow {
  return a.lastSeenAt >= b.lastSeenAt ? a : b;
}

export function matchRegistryToNetwork(devices: RegisteredDevice[], hosts: SeenHostRow[]): Match[] {
  const byMac = new Map<string, SeenHostRow>();
  const byIp = new Map<string, SeenHostRow>();
  for (const host of hosts) {
    if (host.ipAddress) byIp.set(host.ipAddress, host);
    const mac = normalizeMacAddress(host.macAddress);
    if (!mac) continue;
    // Um router que saltou de endereço deixou para trás a linha do endereço
    // antigo. Fica a mais recente: a outra é um endereço que já não é dele.
    const seen = byMac.get(mac);
    byMac.set(mac, seen ? mostRecent(seen, host) : host);
  }

  const matches: Match[] = [];
  for (const device of devices) {
    if (device.mac) {
      const host = byMac.get(device.mac);
      if (host) matches.push({ device, host, via: 'mac' });
      continue;
    }
    // Sem MAC no registo resta o endereço — é assim que um equipamento entra
    // no sistema pela primeira vez e ganha MAC.
    if (device.ip) {
      const host = byIp.get(device.ip);
      if (host) matches.push({ device, host, via: 'ip' });
    }
  }

  return dropAmbiguous(matches);
}

/**
 * Dois registos a reclamar o mesmo aparelho tiram-se **os dois**.
 *
 * É a regra do `fill-macs-from-discovery.cjs` (nunca escrever quando há
 * dúvida), e é ela que impede uma proposta errada de parecer certa: escolher um
 * dos dois seria decidir uma coisa que só quem está no terreno pode decidir.
 */
function dropAmbiguous(matches: Match[]): Match[] {
  const claims = new Map<string, number>();
  for (const match of matches) {
    const key = match.host.ipAddress;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  return matches.filter((match) => claims.get(match.host.ipAddress) === 1);
}

// --------------------------------------------------------------- propostas

export type ProposalKind =
  | 'mac_em_falta'
  | 'ip_em_falta'
  | 'ip_mudou'
  | 'modelo_diferente'
  | 'backbone_ausente';

export type Proposal = {
  kind: ProposalKind;
  targetKind: 'backbone' | 'assignment';
  targetId: number;
  /** De quem é o equipamento — o dono do serviço, ou o nome do backbone. */
  name: string;
  /** O que está no registo agora. `null` = está por preencher. */
  current: string | null;
  /** O que a rede diz que devia estar lá. */
  proposed: string;
  /** Onde o aparelho foi visto, para dar contexto à linha. */
  ip: string;
  /**
   * Para onde vai quem carrega na proposta que não se aplica aqui.
   *
   * `null` no backbone. O `targetId` sozinho é o id da atribuição, e o foco do
   * módulo de Serviços chaveia pelo id do serviço — sem estes dois, a proposta
   * de modelo diferente só sabe dizer onde é, e deixa lá a pessoa.
   */
  serviceId: number | null;
  clientId: number | null;
};

export type ProposalInput = {
  devices: RegisteredDevice[];
  hosts: SeenHostRow[];
  /** `kind|targetKind|targetId` das que já foram dispensadas. */
  dismissed?: Set<string>;
  /** Dias sem resposta a partir dos quais um backbone ativo se propõe em manutenção. */
  absentDays?: number;
  /** Hoje, em `AAAA-MM-DD HH:MM:SS`. Parâmetro para os testes não dependerem do relógio. */
  now?: string;
};

export function dismissalKey(kind: ProposalKind, targetKind: string, targetId: number): string {
  return `${kind}|${targetKind}|${targetId}`;
}

/** Um backbone ativo que não responde há dias é avaria, não configuração. */
const ABSENT_DAYS = 7;

export function buildProposals(input: ProposalInput): Proposal[] {
  const dismissed = input.dismissed ?? new Set<string>();
  const absentDays = input.absentDays ?? ABSENT_DAYS;
  const out: Proposal[] = [];

  const add = (proposal: Proposal) => {
    if (dismissed.has(dismissalKey(proposal.kind, proposal.targetKind, proposal.targetId))) return;
    out.push(proposal);
  };

  for (const { device, host, via } of matchRegistryToNetwork(input.devices, input.hosts)) {
    const base = {
      targetKind: device.kind,
      targetId: device.id,
      name: device.name,
      ip: host.ipAddress,
      serviceId: device.serviceId,
      clientId: device.clientId
    };
    const hostMac = normalizeMacAddress(host.macAddress);

    if (via === 'ip' && !device.mac && hostMac) {
      add({ ...base, kind: 'mac_em_falta', current: null, proposed: hostMac });
    }

    if (via === 'mac') {
      if (!device.ip) {
        add({ ...base, kind: 'ip_em_falta', current: null, proposed: host.ipAddress });
      } else if (device.ip !== host.ipAddress) {
        // O caso do router em DHCP: o aparelho é o mesmo, o endereço é outro.
        add({ ...base, kind: 'ip_mudou', current: device.ip, proposed: host.ipAddress });
      }
    }

    // O modelo não se corrige no lugar — ver `buildProposals` no plano e o
    // comentário do PATCH: mexer no `catalog_id` é mexer no stock. Esta
    // proposta abre a troca de equipamento, que é o que de facto aconteceu.
    if (device.model && host.model && !sameModel(device.model, host.model)) {
      add({ ...base, kind: 'modelo_diferente', current: device.model, proposed: host.model });
    }
  }

  // Um backbone ativo cujo último avistamento já tem dias. Fora do casamento
  // porque a pergunta é sobre a **ausência**, não sobre uma diferença de dados.
  const now = input.now ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
  const cutoff = new Date(new Date(now.replace(' ', 'T') + 'Z').getTime() - absentDays * 86_400_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const hostsByIp = new Map(input.hosts.map((host) => [host.ipAddress, host]));
  for (const device of input.devices) {
    if (device.kind !== 'backbone' || !device.active || !device.ip) continue;
    const host = hostsByIp.get(device.ip);
    // Sem linha nenhuma significa "nunca foi varrido", que não é o mesmo que
    // "não responde" — e propor manutenção a partir disso seria inventar.
    if (!host || host.lastSeenAt >= cutoff) continue;
    add({
      kind: 'backbone_ausente',
      targetKind: 'backbone',
      targetId: device.id,
      name: device.name,
      current: 'ativo',
      proposed: 'manutencao',
      ip: device.ip,
      // O backbone não tem dono: resolve-se no separador Backbone, não em Serviços.
      serviceId: null,
      clientId: null
    });
  }

  return out;
}

// ------------------------------------------------- equipamento sem identidade

export type Orphan = {
  targetKind: 'backbone' | 'assignment';
  targetId: number;
  name: string;
  model: string | null;
  /** Desconhecidos vivos cujo fabricante bate com a marca do catálogo. */
  candidates: Array<{ ip: string; mac: string | null; vendor: string | null; model: string | null }>;
};

/**
 * Acima disto a lista deixa de ser uma ajuda.
 *
 * Medido na rede real: um `TP-Link Archer C20` sem identidade tinha **24**
 * desconhecidos TP-Link para escolher, e o mesmo se repetia em 23 registos.
 * Vinte e quatro candidatos não é uma lista curta, é o palheiro inteiro com
 * outro nome — e uma sugestão que não estreita nada só ensina a ignorar as que
 * estreitam. Quando são muitos, cala-se.
 */
const MAX_CANDIDATES = 6;

/**
 * Equipamento registado que não tem endereço **nem** MAC — nada por onde a rede
 * o reconheça.
 *
 * A lista de candidatos é uma **lista curta para escolher, não uma resposta**.
 * Não há par único a esperar por aqui: o que a máquina pode fazer é reduzir a
 * escolha ao fabricante certo, e só quando essa redução chega para alguma coisa.
 * Quem decide é quem esteve lá.
 */
export function findOrphans(
  devices: RegisteredDevice[],
  hosts: SeenHostRow[],
  claimedIps: Set<string>
): Orphan[] {
  const free = hosts.filter((host) => !claimedIps.has(host.ipAddress) && host.macAddress);

  return devices
    .filter((device) => !device.ip && !device.mac)
    .map((device) => {
      const brand = (device.model ?? '').split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z]/g, '') ?? '';
      const hits = brand
        ? free.filter((host) => (host.vendor ?? '').toUpperCase().replace(/[^A-Z]/g, '').startsWith(brand))
        : [];

      return {
        targetKind: device.kind,
        targetId: device.id,
        name: device.name,
        model: device.model,
        candidates: hits.length > MAX_CANDIDATES
          ? []
          : hits.map((host) => ({
            ip: host.ipAddress,
            mac: host.macAddress,
            vendor: host.vendor,
            model: host.model
          }))
      };
    });
}

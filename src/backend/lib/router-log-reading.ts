import type { RouterLogEntry } from './routeros';

/**
 * A leitura do registo do router: junta o que o RouterOS partiu, encurta o que é só máquina e
 * diz cada linha em português. A tabela de regras saiu dos feitios contados nas linhas
 * guardadas do router real (2026-10-10); o que não tem regra passa tal como veio.
 */
export type LogKind = 'contador' | 'leitura_ispm' | 'pppoe' | 'dhcp' | 'dhcp_estranho' | 'vigia' | 'porta' | 'login' | 'config' | 'outro';

/** `message` é a linha do router (já encurtada); `text` é a frase que o ecrã mostra. */
export type ReadLogEntry = RouterLogEntry & { text: string; kind: LogKind; machine: boolean };

export type LogLookups = {
  /** O utilizador com que o ISPM entra no router. */
  apiUser: string;
  clientOfLogin: (login: string) => string | null;
  aboutMac: (mac: string) => { clientName: string | null; vendor: string | null };
};

// Os contadores guardam os totais no `source` de um script, e o router regista o texto todo.
const COUNTER_WRITE = /^(changed script settings by \S+ \(\/system script set (ispm-(?:wan|client)-usage)-data)\b/;
// Um pedaço de gravação sem a cabeça: "…;rx;tx\; \n# dia;WAN;…". No cartão vem com mais espaços.
const COUNTER_FRAGMENT = /;\d+(?:;[\d:dw]+)?\\;\s+\\n/;
// Mais do que isto não é um texto partido, é outra coisa a correr no mesmo segundo.
const MAX_FRAGMENTS = 40;
// Acima disto, o texto que vem dentro de uma linha de configuração já não se lê: fica "…".
const LONG_TEXT = 300;

/**
 * As linhas de configuração que trazem um texto inteiro lá dentro, e que o registo em memória
 * parte em vários pedaços: o `source` de um script e o `contents` de um ficheiro. Medido no CHR
 * 7.24.2: instalar um contador do ISPM dá cinco linhas destas, e criar o ficheiro de estado
 * mais uma. `closed` reconhece o pedaço que fecha (a aspa final não pode ser uma `\"` do texto).
 */
const CARRIERS = [
  {
    head: /^((?:changed script settings|new script added) by \S+ \(.*?) source="/s,
    closed: /(?<!\\)"\)\s*$/,
    compact: (prefix: string) => `${prefix} source=…)`,
    always: false
  },
  {
    head: /^(add file by \S+ \(\*\w+ = \/file add) contents="/s,
    closed: /(?<!\\)" name=\S+\)\s*$/,
    compact: (prefix: string, last: string) => `${prefix} contents=…${/(?<!\\)"( name=\S+\))\s*$/.exec(last)?.[1] ?? ')'}`,
    // O conteúdo de um ficheiro nunca se lê numa linha de registo: encurta-se sempre.
    always: true
  }
];

const idNumber = (id: string) => Number.parseInt(id.replace(/^\*/, ''), 16) || 0;

/** O que sai e o que encurta: continuações de um texto partido, fragmentos órfãos e cabeças. */
function weighCounters(entries: RouterLogEntry[]) {
  const continued = new Set<RouterLogEntry>();
  const orphans = new Set<RouterLogEntry>();
  const shortened = new Map<RouterLogEntry, string>();
  const inOrder = [...entries].sort((a, b) => idNumber(a.id) - idNumber(b.id));
  const carrierOf = (message: string) => CARRIERS.find((carrier) => carrier.head.test(message));
  for (let index = 0; index < inOrder.length; index += 1) {
    const head = inOrder[index];
    const carrier = carrierOf(head.message);
    if (!carrier) {
      if (COUNTER_FRAGMENT.test(head.message)) orphans.add(head);
      continue;
    }
    const prefix = carrier.head.exec(head.message)![1];
    let last = head.message;
    let pieces = 0;
    if (!carrier.closed.test(head.message)) {
      for (let next = index + 1; next < inOrder.length && pieces < MAX_FRAGMENTS; next += 1) {
        const piece = inOrder[next];
        if (piece.time !== head.time || piece.topics !== head.topics || carrierOf(piece.message)) break;
        continued.add(piece);
        pieces += 1;
        last = piece.message;
        index = next;
        if (carrier.closed.test(piece.message)) break;
      }
    }
    // Um texto curto e inteiro lê-se bem como está; o estado de um contador nunca interessa.
    if (carrier.always || pieces > 0 || !carrier.closed.test(head.message) || head.message.length > LONG_TEXT || COUNTER_WRITE.test(head.message)) {
      shortened.set(head, carrier.compact(prefix.replace(/ policy=""$/, ''), last));
    }
  }
  const shorten = (entry: RouterLogEntry) => {
    const message = shortened.get(entry);
    return message === undefined || message === entry.message ? entry : { ...entry, message };
  };
  return { continued, orphans, shorten };
}

/**
 * As linhas sem o peso dos contadores, para guardar: os fragmentos de uma gravação ficam numa
 * linha só, sem os números, e os fragmentos órfãos saem. A ordem de entrada mantém-se. Pura e
 * idempotente.
 */
export function compactEntries(entries: RouterLogEntry[]): RouterLogEntry[] {
  const { continued, orphans, shorten } = weighCounters(entries);
  return entries.filter((entry) => !continued.has(entry) && !orphans.has(entry)).map(shorten);
}

type Reading = { text: string; kind: LogKind; machine?: boolean };
type Rule = { pattern: RegExp; read: (match: RegExpExecArray, lookups: LogLookups) => Reading };

const withClient = (login: string, lookups: LogLookups) => {
  const client = lookups.clientOfLogin(login);
  return client ? `${login} (${client})` : login;
};

/** Uma interface de sessão (`<pppoe-skn001>`) diz-se pelo acesso; as outras pelo nome. */
const interfaceName = (name: string, lookups: LogLookups) => {
  const login = /^<pppoe-(.+)>$/.exec(name)?.[1];
  return login ? `PPPoE ${withClient(login, lookups)}` : name;
};

const PPPOE_REASONS: Record<string, string> = {
  'peer is not responding': 'o equipamento do cliente deixou de responder',
  'hungup': 'a ligação foi cortada',
  'administrator request': 'pedido do administrador',
  'session timeout': 'fim do tempo da sessão'
};

const PPPOE_STATES: Record<string, string> = {
  connected: 'ligado',
  authenticated: 'autenticado',
  disconnected: 'sessão terminada',
  'terminating...': 'a sessão está a terminar'
};

const DETECT_STATES: Record<string, string> = {
  INTERNET: 'com Internet',
  WAN: 'só chega ao fornecedor',
  LAN: 'só rede local',
  UNKNOWN: 'por determinar'
};

const CONFIG_VERBS: Record<string, string> = { changed: 'alterou', added: 'criou', removed: 'removeu' };
const CONFIG_CHANNELS: Record<string, string> = { winbox: 'WinBox', ssh: 'SSH', telnet: 'Telnet', api: 'API', 'rest-api': 'API', webfig: 'WebFig' };

/** Quem mexeu: `api:ispm-api@::/action:243`, `mac-msg(winbox):admin@54:14:…/terminal`, `scheduler:nome/…`. */
function configActor(raw: string, lookups: LogLookups): string {
  const scheduled = /^scheduler:([^/]+)/.exec(raw);
  if (scheduled) return `O agendamento ${scheduled[1]}`;
  const match = /^([\w-]+)(?:\(([\w-]+)\))?:([^@/]+)/.exec(raw);
  if (!match) return raw;
  if (match[3] === lookups.apiUser) return 'O ISPM';
  const channel = match[2] ?? match[1];
  return `${match[3]} (${CONFIG_CHANNELS[channel] ?? channel})`;
}

function configObject(raw: string, lookups: LogLookups): string {
  const secret = /^ppp secret <(.+)>$/.exec(raw);
  if (secret) return `o acesso PPPoE ${withClient(secret[1], lookups)}`;
  const profile = /^ppp profile <(.+)>$/.exec(raw);
  if (profile) return `o perfil PPP ${profile[1]}`;
  const user = /^user (\S+)$/.exec(raw);
  if (user) return `o utilizador ${user[1]}`;
  return ({
    'log rule': 'uma regra de registo',
    'log action': 'uma ação de registo',
    'Netwatch config': 'uma vigia netwatch',
    'package channel': 'o canal de atualizações',
    script: 'um script'
  } as Record<string, string>)[raw] ?? raw;
}

/** Segundos por extenso: "2 min 23 s", "3 h 05 min". */
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${String(minutes % 60).padStart(2, '0')} min` : `${Math.floor(hours / 24)} d ${String(hours % 24).padStart(2, '0')} h`;
}

const DETAIL_LIMIT = 140;

/** Do comando registado fica só o que mudou: os `chave=valor`. */
function configDetail(command: string | undefined): string {
  const start = (command ?? '').search(/(?<=^|\s)[\w.-]+=/);
  if (start < 0) return '';
  const detail = command!.slice(start).trim();
  return detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail;
}

const RULES: Rule[] = [
  {
    pattern: COUNTER_WRITE,
    read: (m) => ({
      kind: 'contador', machine: true,
      text: m[2] === 'ispm-wan-usage' ? 'Contador das WAN gravou os totais' : 'Contador de consumo por cliente gravou os totais'
    })
  },
  { pattern: COUNTER_FRAGMENT, read: () => ({ kind: 'contador', machine: true, text: 'Contador do ISPM: resto de uma gravação' }) },
  {
    pattern: /^user (\S+) logged (in|out)(?: from (\S+))?(?: via (\S+))?$/,
    read: (m, lookups) => {
      if (m[1] === lookups.apiUser) {
        return { kind: 'leitura_ispm', machine: true, text: m[2] === 'in' ? 'O ISPM ligou-se ao router' : 'O ISPM desligou-se do router' };
      }
      const where = `${m[3] ? ` a partir de ${m[3]}` : ''}${m[4] ? ` por ${m[4]}` : ''}`;
      return { kind: 'login', text: `${m[1]} ${m[2] === 'in' ? 'entrou' : 'saiu'}${where}` };
    }
  },
  {
    pattern: /^login failure for user (.+?) from (\S+) via (\S+)$/,
    read: (m) => ({ kind: 'login', text: `Login falhado do utilizador ${m[1]} a partir de ${m[2]} por ${m[3]}` })
  },
  {
    pattern: /^(\S+): received DHCP server message on untrusted port from source IP (\S+), MAC (\S+)$/,
    // Curta de propósito: a 1225 px a coluna mostra ~75 caracteres, e o MAC é o que interessa ler.
    read: (m) => ({ kind: 'dhcp_estranho', text: `Resposta DHCP na porta não confiável ${m[1]}: ${m[2]}, ${m[3].toUpperCase()}` })
  },
  {
    pattern: /^event (up|down) \[ type: \w+, host: (\S+) \]$/,
    read: (m) => ({ kind: 'vigia', text: `${m[2]} ${m[1] === 'down' ? 'deixou de responder' : 'voltou a responder'}` })
  },
  {
    pattern: /^<pppoe-(.+?)>: terminating\.\.\. - (.+)$/,
    read: (m, lookups) => ({ kind: 'pppoe', text: `PPPoE ${withClient(m[1], lookups)}: a sessão caiu — ${PPPOE_REASONS[m[2]] ?? m[2]}` })
  },
  {
    pattern: /^<pppoe-(.+?)>: (connected|authenticated|disconnected|terminating\.\.\.)$/,
    read: (m, lookups) => ({ kind: 'pppoe', text: `PPPoE ${withClient(m[1], lookups)}: ${PPPOE_STATES[m[2]]}` })
  },
  {
    pattern: /^<[0-9a-f]+>: user (\S+) authentication failed$/,
    read: (m, lookups) => ({ kind: 'pppoe', text: `PPPoE ${withClient(m[1], lookups)}: autenticação falhada` })
  },
  {
    // Medido no CHR 7.24.2: a conta da sessão, com o tempo ligado em segundos à saída.
    pattern: /^(\S+) logged in, (\S+) from (\S+)$/,
    read: (m, lookups) => ({ kind: 'pppoe', text: `PPPoE ${withClient(m[1], lookups)}: entrou com o endereço ${m[2]}` })
  },
  {
    pattern: /^(\S+) logged out, (\d+) \d+ \d+ \d+ \d+ from \S+$/,
    read: (m, lookups) => ({ kind: 'pppoe', text: `PPPoE ${withClient(m[1], lookups)}: saiu ao fim de ${duration(Number(m[2]))}` })
  },
  { pattern: /^router rebooted\b.*$/, read: () => ({ kind: 'outro', text: 'O router reiniciou' }) },
  {
    pattern: /^PPPoE connection established from (\S+)$/,
    read: (m, lookups) => {
      const client = lookups.aboutMac(m[1].toUpperCase()).clientName;
      return { kind: 'pppoe', text: `Pedido de ligação PPPoE de ${m[1].toUpperCase()}${client ? ` (${client})` : ''}` };
    }
  },
  {
    pattern: /^(\S+) detect (INTERNET|WAN|LAN|UNKNOWN)$/,
    read: (m, lookups) => ({ kind: 'porta', text: `${interfaceName(m[1], lookups)}: deteção de Internet — ${DETECT_STATES[m[2]]}` })
  },
  {
    pattern: /^(\S+) link (down|up)(?: \((?:speed )?(.+)\))?$/,
    read: (m) => ({ kind: 'porta', text: m[2] === 'down' ? `Porta ${m[1]} sem ligação` : `Porta ${m[1]} com ligação${m[3] ? ` (${m[3]})` : ''}` })
  },
  {
    pattern: /^\S+ (assigned|deassigned) (\S+) (?:for|to) (\S+)(?: (.+))?$/,
    read: (m, lookups) => {
      const mac = m[3].toUpperCase();
      const who = lookups.aboutMac(mac).clientName ?? m[4];
      return { kind: 'dhcp', text: `DHCP: ${m[2]} ${m[1] === 'assigned' ? 'entregue a' : 'libertado por'} ${mac}${who ? ` (${who})` : ''}` };
    }
  },
  {
    pattern: /^\S+ offering lease (\S+) for (\S+) without success$/,
    read: (m, lookups) => {
      const mac = m[2].toUpperCase();
      const client = lookups.aboutMac(mac).clientName;
      return { kind: 'dhcp', text: `DHCP: ${m[1]} oferecido a ${mac}${client ? ` (${client})` : ''} sem resposta` };
    }
  },
  {
    pattern: /^\S+ on (\S+) (got|lost) IP address (\S+)(?: - .+)?$/,
    read: (m) => ({ kind: 'porta', text: `${m[1]} ${m[2] === 'got' ? 'recebeu' : 'perdeu'} o endereço ${m[3]}` })
  },
  {
    // Medido em 2026-10-10: criar um ficheiro regista-se; escrever num que já existe, não.
    pattern: /^add file by (\S+)(?: \((?:\*\w+ = )?\/file add (.*)\))?$/s,
    read: (m, lookups) => ({ kind: 'config', text: `${configActor(m[1], lookups)} criou o ficheiro ${/\bname=(\S+)/.exec(m[2] ?? '')?.[1] ?? ''}`.trimEnd() })
  },
  {
    pattern: /^new script (added|scheduled) by (\S+)(?: \((.*)\))?$/s,
    read: (m, lookups) => {
      const name = /\bname=(\S+)/.exec(m[3] ?? '')?.[1];
      return { kind: 'config', text: `${configActor(m[2], lookups)} criou o ${m[1] === 'added' ? 'script' : 'agendamento'}${name ? ` ${name}` : ''}` };
    }
  },
  {
    // Esta traz o verbo à frente, ao contrário das outras alterações.
    pattern: /^changed script settings by (\S+)(?: \(\/system script set (\S+).*\))?$/s,
    read: (m, lookups) => ({ kind: 'config', text: `${configActor(m[1], lookups)} alterou o script${m[2] ? ` ${m[2]}` : ''}` })
  },
  {
    pattern: /^(.+?) (changed|added|removed) by (\S+)(?: \((.*)\))?$/s,
    read: (m, lookups) => {
      const detail = configDetail(m[4]);
      return { kind: 'config', text: `${configActor(m[3], lookups)} ${CONFIG_VERBS[m[2]]} ${configObject(m[1], lookups)}${detail ? `: ${detail}` : ''}` };
    }
  }
];

/**
 * Cada linha com a sua frase. O que é só máquina vem marcado, para o ecrã o poder esconder;
 * um fragmento órfão fica à vista (marcado), porque o ecrã mostra tudo o que o router tem. Pura.
 */
export function readLog(entries: RouterLogEntry[], lookups: LogLookups): ReadLogEntry[] {
  const { continued, shorten } = weighCounters(entries);
  return entries.filter((entry) => !continued.has(entry)).map((entry) => {
    const line = shorten(entry);
    const message = line.message.trim();
    for (const rule of RULES) {
      const match = rule.pattern.exec(message);
      if (match) {
        const reading = rule.read(match, lookups);
        return { ...line, text: reading.text, kind: reading.kind, machine: reading.machine ?? false };
      }
    }
    return { ...line, text: message, kind: 'outro', machine: false };
  });
}

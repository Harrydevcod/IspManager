#!/usr/bin/env node
/* eslint-disable */
/**
 * Fase 0: **medir antes de curar.**
 *
 * Este script não decide nada. Vai à rede, pergunta a cada endereço vivo tudo o
 * que se lhe pode perguntar sobre que aparelho é, e escreve as respostas em
 * bruto num ficheiro. É esse ficheiro que decide quais os canais que valem a
 * pena e como se lê um modelo em cada um.
 *
 * A razão de existir está no histórico deste projeto: um mapa de fabricantes
 * escrito de cabeça acertou 0 em 54 na rede real e foi deitado fora. Escrever
 * assinaturas de firmware a partir de memória seria o mesmo erro. Aqui olha-se
 * primeiro.
 *
 * A primeira medição (2026-08-27) matou dois canais e salvou um: SNMP 0/42,
 * Pharos 0/42, HTTP 26/42. O mDNS entrou depois, com a pergunta que a app da
 * Starlink responde de graça — quem é este aparelho, dito por ele próprio.
 *
 * **E o mDNS morreu aqui (2026-08-28, 43 vivos):** unicast `_services` 1/43,
 * unicast `_device-info` 0/43, multicast 0/43. O único a responder anunciou
 * `_airplay._tcp` — uma televisão de um cliente. É o retrato exato de porque é
 * que a app da Starlink parece mágica e isto não: lá os clientes são telemóveis
 * e portáteis, que se anunciam sozinhos; aqui são CPE e antenas, que não falam.
 * O canal fica medido e não se implementa. As sondas ficam para o dia em que o
 * parque mude.
 *
 * Não escreve na base de dados. Não altera nada em equipamento nenhum. Só lê.
 *
 *   node scripts/probe-models.cjs 192.168.1.1-254
 *   node scripts/probe-models.cjs 10.0.0.0/24 --out C:\\tmp\\sondagem.json
 *
 * O resultado vai para `.scratch/model-probe-<data>.json`, que é o ficheiro a
 * enviar a quem for escrever as assinaturas.
 */

const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const TIMEOUT_MS = 1500;
const CONCURRENCY = 8;
const MAX_BODY = 16 * 1024;

// ------------------------------------------------------------- endereços

function expandRange(input) {
  const cidr = /^(\d+\.\d+\.\d+)\.(\d+)\/(\d+)$/.exec(input);
  if (cidr) {
    const bits = Number(cidr[3]);
    if (bits < 22 || bits > 32) throw new Error('Máscara fora do que faz sentido varrer (/22 a /32)');
    const size = 2 ** (32 - bits);
    const base = ipToInt(`${cidr[1]}.${cidr[2]}`) & ~(size - 1);
    const out = [];
    for (let i = 1; i < size - 1; i += 1) out.push(intToIp(base + i));
    return out;
  }

  const range = /^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/.exec(input);
  if (range) {
    const out = [];
    for (let i = Number(range[2]); i <= Number(range[3]); i += 1) out.push(`${range[1]}.${i}`);
    return out;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) return [input];
  throw new Error(`Intervalo inválido: ${input}`);
}

const ipToInt = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
const intToIp = (value) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i], i);
  }));
  return results;
}

function ping(ip) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32'
      ? ['-n', '1', '-w', String(TIMEOUT_MS), ip]
      : ['-c', '1', '-W', '1', ip];
    execFile('ping', args, { timeout: TIMEOUT_MS + 800, windowsHide: true }, (error, stdout) => {
      resolve(!error && /ttl[= ]/i.test(String(stdout)));
    });
  });
}

// ---------------------------------------------------------------- canais

function httpBanner(ip, scheme) {
  return new Promise((resolve) => {
    const client = scheme === 'https' ? https : http;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    const request = client.request({
      host: ip,
      port: scheme === 'https' ? 443 : 80,
      path: '/',
      method: 'GET',
      timeout: TIMEOUT_MS,
      // GET anónimo a equipamento com certificado auto-assinado. Nada sai por
      // esta ligação — não há credencial nenhuma para proteger.
      rejectUnauthorized: false,
      agent: false
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BODY) response.destroy();
      });
      const end = () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body);
        finish({
          status: response.statusCode ?? 0,
          headers: {
            server: response.headers['server'] ?? null,
            'www-authenticate': response.headers['www-authenticate'] ?? null,
            'set-cookie': response.headers['set-cookie'] ?? null,
            location: response.headers['location'] ?? null
          },
          title: title ? title[1].replace(/\s+/g, ' ').trim() : null,
          // Os primeiros 2 KB chegam para ver como a página se apresenta.
          bodyHead: body.slice(0, 2048)
        });
      };
      response.on('end', end);
      response.on('close', end);
      response.on('error', () => finish(null));
    });

    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
    request.end();
  });
}

/**
 * GetRequest SNMPv2c por `sysDescr.0`, community "public".
 *
 * Montado em vez de escrito byte a byte: cada TLV carrega o comprimento do que
 * vem dentro, portanto uma constante fixa fica errada assim que alguém mexer
 * numa linha acima — e um pacote com comprimento errado não dá erro, dá
 * silêncio, que aqui se leria como "este equipamento não fala SNMP".
 */
function snmpGetPacket() {
  const tlv = (tag, payload) => Buffer.concat([Buffer.from([tag, payload.length]), payload]);
  const varbind = tlv(0x30, Buffer.concat([
    tlv(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00])),
    tlv(0x05, Buffer.alloc(0))
  ]));
  const pdu = tlv(0xa0, Buffer.concat([
    tlv(0x02, Buffer.from([0x00, 0x00, 0x00, 0x01])),
    tlv(0x02, Buffer.from([0x00])),
    tlv(0x02, Buffer.from([0x00])),
    tlv(0x30, varbind)
  ]));
  return tlv(0x30, Buffer.concat([
    tlv(0x02, Buffer.from([0x01])),
    tlv(0x04, Buffer.from('public', 'latin1')),
    pdu
  ]));
}

function snmpSysDescr(ip) {
  const packet = snmpGetPacket();

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* já fechado */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    socket.on('message', (reply) => finish({ hex: reply.toString('hex'), ascii: printable(reply) }));
    socket.on('error', () => finish(null));
    socket.send(packet, 161, ip, (error) => { if (error) finish(null); });
  });
}

/**
 * Descoberta da TP-Link Pharos, em UDP 29810.
 *
 * O formato é proprietário e não está documentado. Manda-se um datagrama de
 * sondagem e guarda-se **em bruto** o que voltar, sem tentar interpretar nada:
 * é justamente para saber se vale a pena investir neste canal que este script
 * existe. Se nada responder, o canal morre aqui e poupa-se o código todo.
 */
function pharosProbe(ip) {
  const packet = Buffer.alloc(28);
  packet[0] = 0x01; // versão
  packet[1] = 0x01; // opcode: discovery request

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* já fechado */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    socket.on('message', (reply) => finish({ hex: reply.toString('hex'), ascii: printable(reply) }));
    socket.on('error', () => finish(null));
    socket.send(packet, 29810, ip, (error) => { if (error) finish(null); });
  });
}

const printable = (buffer) => buffer.toString('latin1').replace(/[^\x20-\x7e]/g, '.');

// ------------------------------------------------------------------ mDNS

/**
 * mDNS/Bonjour — o canal que faz a app da Starlink parecer mágica.
 *
 * Quem responde diz o nome **e** o modelo sem que ninguém tenha de interpretar
 * HTML: o `_device-info._tcp` traz um TXT com `model=`. É a diferença entre o
 * aparelho dizer o que é, e nós adivinharmos pelo título da página de login.
 *
 * Mede-se de duas maneiras porque a diferença entre elas decide tudo:
 *
 *   - **multicast** (224.0.0.251) apanha o segmento local e mais nada. Numa rede
 *     como esta, a ponte sem fios até ao CPE do cliente costuma comer o
 *     multicast, e então este número vem baixo sem o canal ser inútil.
 *   - **unicast** manda a mesma pergunta ao endereço do equipamento, na porta
 *     5353. É o que o `dns-sd -U` faz, e é encaminhável: se este responder, o
 *     mDNS pode ser uma sondagem por equipamento como a do HTTP, que já se sabe
 *     que chega lá.
 *
 * Não se interpreta nada aqui. Guarda-se o que voltou, tal como no Pharos: um
 * canal só ganha assinaturas depois de haver respostas reais para as escrever.
 */

const MDNS_PORT = 5353;
const MDNS_GROUP = '224.0.0.251';

/** Os dois nomes que valem a pena: o que enumera serviços, e o que traz o modelo. */
const MDNS_NAMES = ['_services._dns-sd._udp.local', '_device-info._tcp.local'];

/**
 * Um pedido DNS cru. O `qu` liga o bit de topo da classe ("quero a resposta em
 * unicast"), sem o qual uma pergunta em multicast é respondida em multicast e
 * não volta ao porto efémero de onde saiu.
 */
function dnsQuery(name, qu) {
  const labels = name.split('.').filter(Boolean);
  const size = 12 + labels.reduce((total, label) => total + 1 + label.length, 0) + 1 + 4;
  const packet = Buffer.alloc(size);

  packet.writeUInt16BE(Math.floor(Math.random() * 65535), 0); // id
  packet.writeUInt16BE(0x0000, 2); // pergunta normal, sem recursão
  packet.writeUInt16BE(1, 4); // uma pergunta

  let offset = 12;
  for (const label of labels) {
    packet.writeUInt8(label.length, offset);
    offset += 1;
    offset += packet.write(label, offset, 'ascii');
  }
  packet.writeUInt8(0, offset);
  offset += 1;
  packet.writeUInt16BE(12, offset); // PTR
  packet.writeUInt16BE(qu ? 0x8001 : 0x0001, offset + 2); // IN, com ou sem bit QU
  return packet;
}

/** Pergunta a um endereço concreto. É esta que decide se o canal é encaminhável. */
function mdnsUnicast(ip, name) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* já fechado */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    socket.on('message', (reply) => finish({ hex: reply.toString('hex'), ascii: printable(reply) }));
    socket.on('error', () => finish(null));
    socket.send(dnsQuery(name, false), MDNS_PORT, ip, (error) => { if (error) finish(null); });
  });
}

/**
 * Uma pergunta ao grupo inteiro, e escuta-se quem aparecer.
 *
 * Não entra no grupo multicast de propósito: com o bit QU as respostas voltam em
 * unicast ao porto efémero, e assim não se disputa a porta 5353 com um Bonjour
 * que esteja instalado nesta máquina.
 */
function mdnsMulticast(waitMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const heard = new Map();

    socket.on('message', (reply, info) => {
      if (heard.has(info.address)) return;
      heard.set(info.address, { hex: reply.toString('hex'), ascii: printable(reply) });
    });
    socket.on('error', () => { /* uma rede sem multicast não é um erro a reportar */ });

    socket.bind(() => {
      try { socket.setMulticastTTL(1); } catch { /* algumas interfaces recusam */ }
      for (const name of MDNS_NAMES) {
        socket.send(dnsQuery(name, true), MDNS_PORT, MDNS_GROUP, () => { /* falhar é um resultado */ });
      }
      setTimeout(() => {
        try { socket.close(); } catch { /* já fechado */ }
        resolve(Object.fromEntries(heard));
      }, waitMs);
    });
  });
}


// ------------------------------------------------------------------ main

async function main() {
  const args = process.argv.slice(2);
  const rangeArg = args.find((arg) => !arg.startsWith('--'));
  if (!rangeArg) {
    console.error('Uso: node scripts/probe-models.cjs <intervalo> [--out ficheiro.json]');
    console.error('  ex: node scripts/probe-models.cjs 192.168.1.1-254');
    process.exit(1);
  }

  const outIndex = args.indexOf('--out');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outPath = outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : path.join('.scratch', `model-probe-${stamp}.json`);

  const ips = expandRange(rangeArg);
  console.log(`A varrer ${ips.length} endereços…`);
  const aliveFlags = await mapWithLimit(ips, 32, ping);
  const alive = ips.filter((_, index) => aliveFlags[index]);
  console.log(`${alive.length} responderam. A sondar (isto demora)…`);

  // O multicast corre uma vez para a rede toda — perguntá-lo a cada endereço
  // seria a mesma pergunta repetida ao mesmo grupo.
  console.log('  a ouvir mDNS em multicast (3 s)…');
  const mdnsGroup = await mdnsMulticast(3000);

  let done = 0;
  const findings = await mapWithLimit(alive, CONCURRENCY, async (ip) => {
    const [http80, https443, snmp, pharos, mdnsServices, mdnsDevice] = await Promise.all([
      httpBanner(ip, 'http'),
      httpBanner(ip, 'https'),
      snmpSysDescr(ip),
      pharosProbe(ip),
      mdnsUnicast(ip, MDNS_NAMES[0]),
      mdnsUnicast(ip, MDNS_NAMES[1])
    ]);
    done += 1;
    process.stdout.write(`\r  ${done}/${alive.length}`);
    return {
      ip, http80, https443, snmp, pharos, mdnsServices, mdnsDevice,
      // Se este endereço esteve entre os que responderam ao grupo.
      mdnsMulticast: mdnsGroup[ip] ?? null
    };
  });
  process.stdout.write('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ range: rangeArg, at: stamp, mdnsGroup, findings }, null, 2),
    'utf8'
  );

  const answered = (key) => findings.filter((row) => row[key]).length;
  console.log('');
  console.log(`Escrito: ${outPath}`);
  console.log('Quantos responderam por canal (é isto que decide o que se implementa):');
  console.log(`  HTTP :80    ${answered('http80')}/${alive.length}`);
  console.log(`  HTTPS :443  ${answered('https443')}/${alive.length}`);
  console.log(`  SNMP :161   ${answered('snmp')}/${alive.length}`);
  console.log(`  Pharos      ${answered('pharos')}/${alive.length}`);
  console.log(`  mDNS unicast (_services)     ${answered('mdnsServices')}/${alive.length}`);
  console.log(`  mDNS unicast (_device-info)  ${answered('mdnsDevice')}/${alive.length}`);
  console.log(`  mDNS multicast               ${answered('mdnsMulticast')}/${alive.length}`);
  // O unicast é a linha que decide: o multicast pode responder de tudo o que
  // está neste segmento sem que nenhum CPE do outro lado da ponte apareça.
  console.log(`  (ao grupo respondeu ${Object.keys(mdnsGroup).length}, incluindo fora do intervalo)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

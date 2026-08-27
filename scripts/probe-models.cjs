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

  let done = 0;
  const findings = await mapWithLimit(alive, CONCURRENCY, async (ip) => {
    const [http80, https443, snmp, pharos] = await Promise.all([
      httpBanner(ip, 'http'),
      httpBanner(ip, 'https'),
      snmpSysDescr(ip),
      pharosProbe(ip)
    ]);
    done += 1;
    process.stdout.write(`\r  ${done}/${alive.length}`);
    return { ip, http80, https443, snmp, pharos };
  });
  process.stdout.write('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ range: rangeArg, at: stamp, findings }, null, 2), 'utf8');

  const answered = (key) => findings.filter((row) => row[key]).length;
  console.log('');
  console.log(`Escrito: ${outPath}`);
  console.log('Quantos responderam por canal (é isto que decide o que se implementa):');
  console.log(`  HTTP :80    ${answered('http80')}/${alive.length}`);
  console.log(`  HTTPS :443  ${answered('https443')}/${alive.length}`);
  console.log(`  SNMP :161   ${answered('snmp')}/${alive.length}`);
  console.log(`  Pharos      ${answered('pharos')}/${alive.length}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

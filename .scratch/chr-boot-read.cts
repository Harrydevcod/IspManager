// Leitura logo após o arranque (v10/v6) contra o CHR, com o router ligado há menos de 10 min:
// ficheiros ainda não listados, ou listados mas vazios, não podem levar o histórico.
// A v9 (o mesmo script sem a guarda) tem de falhar os mesmos cenários.
// npx tsx .scratch/chr-boot-read.cts
const { ensureWanUsageCounter } = require('../src/backend/lib/routeros');
const BASE = 'http://127.0.0.1:18080/rest';
const admin = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { authorization: 'Basic ' + Buffer.from('admin:').toString('base64'), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const transport = async ({ method, path, body }: any) => admin(method, path, body);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const uptime = async () => (await admin('GET', '/system/resource?.proplist=uptime')).uptime as string;
const run = (name: string) => admin('POST', '/system/script/run', { '.id': name }).catch((err) => String(err));
const exec = (script: string) => admin('POST', '/execute', { script, 'as-string': 'true' });
const exists = async (name: string) => ((await admin('GET', `/file?name=${encodeURIComponent(name)}`)) as any[]).length > 0;
const fileText = async (name: string) => (await exists(name)) ? (await exec(`:put [/file get "${name}" contents]`)).ret as string : null;
const writeFile = (name: string, contents: string) => exec(`:if ([:len [/file find where name="${name}"]] = 0) do={ /file add name="${name}" contents="" }; /file set "${name}" contents="${contents.replace(/\n/g, '\\n')}"`);
const warnings = async () => ((await admin('GET', '/log?.proplist=topics,message')) as any[])
  .filter((row) => /warning/.test(row.topics) && /ispm-wan-usage/.test(row.message)).map((row) => row.message as string);

const DISK = 'pcie1';
const MAIN = `${DISK}/ispm-wan-usage.txt`;
const BACK = `${DISK}/ispm-wan-usage.bak.txt`;
const HISTORY = ['# 20741;ether1;111;222', '# 20758;ether1;333;444'];
const STATE = `# uptime;3d00:00:00\n# last;ether1;1;1\n${HISTORY.join('\n')}\n# fim\n`;
let failed = 0;
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failed++; console.log(ok ? 'OK  ' : 'FALHA', label, ok ? '' : JSON.stringify(detail).slice(0, 160)); };
const hasHistory = (text: string | null) => !!text && HISTORY.every((line) => text.includes(line));

async function scenarios(version: string) {
  const seed = async () => { await writeFile(BACK, STATE); await writeFile(MAIN, STATE); };
  // 1. O disco já é `type=disk` mas os ficheiros ainda não aparecem.
  await seed();
  await exec(`/file remove "${MAIN}"; /file remove "${BACK}"`);
  await run('ispm-wan-usage');
  const created = await fileText(MAIN);
  await seed();
  await run('ispm-wan-usage');
  check(`${version}: ficheiros por listar no arranque → histórico conservado`, created === null && hasHistory(await fileText(MAIN)), created ?? '');
  // 2. Os ficheiros aparecem mas o texto vem vazio.
  await writeFile(BACK, ''); await writeFile(MAIN, '');
  await run('ispm-wan-usage');
  const after = await fileText(MAIN);
  await seed();
  await run('ispm-wan-usage');
  check(`${version}: ficheiros vazios no arranque → nada gravado`, after === '' && hasHistory(await fileText(MAIN)), after ?? '');
}

async function main() {
  if (((await admin('GET', '/interface/list?name=WAN')) as any[]).length === 0) {
    await admin('PUT', '/interface/list', { name: 'WAN' });
    await admin('PUT', '/interface/list/member', { list: 'WAN', interface: 'ether1' });
  }
  const disk = ((await admin('GET', '/disk')) as any[]).find((d) => d.slot === DISK);
  if (!disk.fs || disk.fs === '-') { await admin('POST', '/disk/format', { numbers: DISK, 'file-system': 'ext4', 'mbr-partition-table': 'no' }); await sleep(5000); }
  console.log('ligado há', await uptime());

  await writeFile(BACK, STATE); await writeFile(MAIN, STATE);
  await ensureWanUsageCounter(transport, DISK);
  // O agendamento de 5 em 5 min não deve correr a meio: só as corridas pedidas aqui.
  await exec('/system scheduler disable [find where name~"ispm-wan-usage"]');
  await scenarios('v10');
  const seen = await warnings();
  check('v10: avisos no registo', seen.some((m) => /ainda por ler/.test(m)) && seen.some((m) => /sem # fim/.test(m)), JSON.stringify(seen));

  // A v9: o mesmo script sem a guarda.
  const [script] = await admin('GET', '/system/script?name=ispm-wan-usage') as any[];
  const v9 = (script.source as string).replace(/\n {4}:if \(\[:len \$text\] = 0\) do=\{[\s\S]*?:error "estado por ler"\n {6}\}\n {4}\}/, '');
  if (v9 === script.source) throw new Error('guarda não encontrada para tirar');
  await admin('PATCH', `/system/script/${script['.id']}`, { source: v9 });
  failed = 0;
  await scenarios('v9');
  console.log(failed === 2 ? 'v9 falha os dois cenários, como esperado' : `v9: ${failed} falha(s) — o teste não distingue as versões`);
  const v9Ok = failed === 2;

  // 3. Instalação nova depois dos 10 minutos: grava.
  await admin('PATCH', `/system/script/${script['.id']}`, { source: script.source });
  for (;;) { const up = await uptime(); if (!/^\d+s$|^[0-9]m/.test(up)) break; await sleep(15000); }
  await exec(`/file remove "${MAIN}"; /file remove "${BACK}"`);
  failed = 0;
  await run('ispm-wan-usage');
  const fresh = await fileText(MAIN);
  check(`v10 (ligado há ${await uptime()}): instalação nova cria o ficheiro`, !!fresh && fresh.trimEnd().endsWith('# fim'), fresh ?? '');
  console.log(failed === 0 && v9Ok ? 'tudo certo' : 'falhou');
  process.exit(failed === 0 && v9Ok ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });

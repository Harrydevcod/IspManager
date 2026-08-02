/**
 * Emissor de licenças do ISPM — ferramenta do fornecedor, nunca empacotada.
 *
 *   npx tsx scripts/issue-license.ts keygen
 *   npx tsx scripts/issue-license.ts fingerprint
 *   npx tsx scripts/issue-license.ts issue --customer "Nova Tech, Lda" --months 12
 *   npx tsx scripts/issue-license.ts verify licencas/LIC-2026-0001.ispmlic
 *
 * A chave PRIVADA vive fora do repositório (por omissão `~/.ispm-license/`) e é
 * o que dá direito a emitir licenças: perdê-la obriga a reemitir tudo, expô-la
 * entrega o produto. Só a chave pública entra no código.
 *
 * Cada emissão fica registada em `registry.json`, ao lado da chave — é o
 * registo de vendas enquanto a cobrança for manual.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { licenseClaimSchema, toIsoDate, type LicenseClaim } from '../src/shared/license';
import { generateLicenseKeyPair, signLicense, verifyLicenseToken } from '../src/backend/lib/license-signature';
import { machineFingerprint } from '../src/backend/lib/license';

type RegistryEntry = { id: string; customer: string; kind: string; issuedAt: string; expiresAt: string | null; file: string };

function issuerDir(): string {
  return process.env.ISPM_LICENSE_DIR || path.join(os.homedir(), '.ispm-license');
}

const privateKeyPath = () => path.join(issuerDir(), 'private.pem');
const publicKeyPath = () => path.join(issuerDir(), 'public.pem');
const registryPath = () => path.join(issuerDir(), 'registry.json');

function readRegistry(): RegistryEntry[] {
  if (!existsSync(registryPath())) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch {
    return [];
  }
}

function nextLicenseId(year: number, registry: RegistryEntry[]): string {
  const prefix = `LIC-${year}-`;
  const used = registry
    .filter((entry) => entry.id.startsWith(prefix))
    .map((entry) => Number(entry.id.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

/**
 * Soma meses mantendo o dia do mês. Sem o ajuste, 31-01 + 1 mês daria 03-03 e
 * a licença expirava no dia errado — numa licença paga isso é um telefonema.
 */
function addMonths(from: Date, months: number): Date {
  const day = from.getDate();
  const result = new Date(from.getFullYear(), from.getMonth() + months, day);
  if (result.getDate() !== day) result.setDate(0); // recua para o último dia do mês certo
  return result;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------- comandos

function keygen(): void {
  mkdirSync(issuerDir(), { recursive: true });
  if (existsSync(privateKeyPath())) {
    fail(`Já existe uma chave privada em ${privateKeyPath()}.\n  Apagá-la invalida todas as licenças emitidas. Remova-a à mão se é mesmo isso que quer.`);
  }

  const { publicKey, privateKey } = generateLicenseKeyPair();
  writeFileSync(privateKeyPath(), privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath(), publicKey, 'utf8');

  console.log(`\n  Chave privada: ${privateKeyPath()}  (guarde-a e faça cópia de segurança)`);
  console.log(`  Chave pública: ${publicKeyPath()}`);
  console.log('\n  Cole a pública em src/backend/lib/license-key.ts, em EMBEDDED_PUBLIC_KEY:\n');
  console.log(publicKey.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'));
  console.log('\n  Enquanto EMBEDDED_PUBLIC_KEY estiver vazia, o licenciamento fica desligado.\n');
}

function issue(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      customer: { type: 'string' },
      nif: { type: 'string' },
      kind: { type: 'string', default: 'subscricao' },
      bind: { type: 'string', default: 'none' },
      fingerprint: { type: 'string' },
      months: { type: 'string', default: '12' },
      grace: { type: 'string' },
      id: { type: 'string' },
      out: { type: 'string' }
    }
  });

  if (!existsSync(privateKeyPath())) fail(`Sem chave privada em ${privateKeyPath()}. Corra primeiro: keygen`);
  if (!values.customer) fail('Falta --customer "Nome do cliente".');
  if (values.kind !== 'subscricao' && values.kind !== 'perpetua') fail('--kind tem de ser subscricao ou perpetua.');
  if (values.bind !== 'none' && values.bind !== 'machine') fail('--bind tem de ser none ou machine.');
  if (values.bind === 'machine' && !values.fingerprint) {
    fail('--bind machine exige --fingerprint <impressão digital da máquina do cliente>.\n  O cliente lê-a no ecrã de licença do ISPM.');
  }

  const months = Number(values.months);
  if (!Number.isInteger(months) || months <= 0) fail('--months tem de ser um número inteiro de meses.');

  const now = new Date();
  const registry = readRegistry();
  const id = values.id || nextLicenseId(now.getFullYear(), registry);
  const until = toIsoDate(addMonths(now, months));

  const claim: LicenseClaim = licenseClaimSchema.parse({
    v: 1,
    id,
    customer: values.customer,
    ...(values.nif ? { nif: values.nif } : {}),
    kind: values.kind,
    bind: values.bind,
    ...(values.fingerprint ? { fingerprint: values.fingerprint } : {}),
    issuedAt: toIsoDate(now),
    // Subscrição: expira. Perpétua: nunca expira, só a manutenção caduca.
    ...(values.kind === 'subscricao' ? { expiresAt: until } : { maintenanceUntil: until }),
    ...(values.grace ? { graceDays: Number(values.grace) } : {})
  });

  const token = signLicense(claim, readFileSync(privateKeyPath(), 'utf8'));
  const outFile = values.out || path.join(issuerDir(), 'emitidas', `${id}.ispmlic`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${token}\n`, 'utf8');

  registry.push({
    id,
    customer: claim.customer,
    kind: claim.kind,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt ?? null,
    file: outFile
  });
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`\n  ${id} — ${claim.customer}`);
  console.log(`  ${claim.kind === 'subscricao' ? `Expira em ${claim.expiresAt}` : `Perpétua, manutenção até ${claim.maintenanceUntil}`}`);
  console.log(`  ${claim.bind === 'machine' ? `Ligada à máquina ${claim.fingerprint}` : 'Chave simples (qualquer máquina)'}`);
  console.log(`\n  Ficheiro: ${outFile}\n`);
}

function verify(argv: string[]): void {
  const file = argv[0];
  if (!file) fail('Indique o ficheiro: verify <ficheiro.ispmlic>');
  if (!existsSync(publicKeyPath())) fail(`Sem chave pública em ${publicKeyPath()}. Corra primeiro: keygen`);

  const result = verifyLicenseToken(readFileSync(file, 'utf8'), readFileSync(publicKeyPath(), 'utf8'));
  if (!result.ok) fail(`Licença inválida: ${result.reason}`);

  console.log(`\n${JSON.stringify(result.claim, null, 2)}\n`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'keygen':
    keygen();
    break;
  case 'issue':
    issue(rest);
    break;
  case 'verify':
    verify(rest);
    break;
  case 'fingerprint':
    console.log(`\n  ${machineFingerprint()}\n`);
    break;
  default:
    console.log(`
  Emissor de licenças do ISPM

    keygen                          cria o par de chaves (uma vez)
    fingerprint                     impressão digital desta máquina
    issue --customer "Nome" [...]   emite uma licença
    verify <ficheiro.ispmlic>       inspeciona uma licença emitida

  Opções de issue:
    --customer <nome>       obrigatório
    --nif <nif>             NIF do cliente (9 dígitos, começa por 1 ou 2)
    --kind <tipo>           subscricao (por omissão) | perpetua
    --bind <modo>           none (por omissão) | machine
    --fingerprint <hash>    obrigatório com --bind machine
    --months <n>            validade ou manutenção, em meses (por omissão 12)
    --grace <n>             dias de tolerância (por omissão 14)
    --id <LIC-AAAA-NNNN>    forçar a referência
    --out <ficheiro>        destino do .ispmlic
`);
}

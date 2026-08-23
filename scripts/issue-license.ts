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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { licenseClaimSchema, toIsoDate, type LicenseClaim } from '../src/shared/license';
import { generateLicenseKeyPair, signLicense, verifyLicenseToken } from '../src/backend/lib/license-signature';
import { machineFingerprint } from '../src/backend/lib/license';

type RegistryEntry = {
  id: string;
  customer: string;
  nif?: string;
  kind: string;
  issuedAt: string;
  expiresAt: string | null;
  /** Pasta do titular dentro de `emitidas/`. Ausente nas emissões antigas. */
  dir?: string;
  file: string;
};

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

/**
 * Pasta do titular dentro de `emitidas/`. O nome sozinho não identifica ninguém
 * — dois clientes podem chamar-se "Tony Alves" — por isso a pasta leva também o
 * NIF, que é o identificador real do titular e o que já liga a licença à
 * faturação. Sem NIF fica só o nome, e a emissão avisa.
 *
 * O slug segue o idioma de `pppoeUsernameFor()` (src/backend/lib/services.ts):
 * sem acentos, minúsculas, hífenes. É o próprio slug que garante o resto — o
 * resultado só pode conter `[a-z0-9-]`, portanto um `--customer "../../.ssh"`
 * sai como `ssh` e nunca escapa da pasta.
 */
export function customerFolder(customer: string, nif?: string): string {
  const slug = customer
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return [slug || 'cliente', nif].filter(Boolean).join('-');
}

/**
 * Pasta que este titular já usa, se houver. Sem isto, emitir a primeira licença
 * sem `--nif` e a renovação com `--nif` dava duas pastas para o mesmo cliente.
 * Quem tem NIF só casa por NIF; o nome só serve para as emissões que ainda não
 * o tinham.
 */
function existingFolder(registry: RegistryEntry[], customer: string, nif?: string): string | null {
  if (nif) {
    const byNif = registry.find((entry) => entry.nif === nif && entry.dir);
    if (byNif?.dir) return byNif.dir;
  }
  const slug = customerFolder(customer);
  const byName = registry.find((entry) => entry.dir && !entry.nif && customerFolder(entry.customer) === slug);
  return byName?.dir ?? null;
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

/**
 * Pasta onde esta emissão vai cair, promovendo a do titular quando ele passa a
 * ter NIF. A primeira licença pode sair sem `--nif` (`tony-alves`); quando a
 * renovação já o traz, a pasta passa a `tony-alves-2XXXXXXXX` **com as licenças
 * antigas lá dentro**. Um titular, uma pasta — senão o identificador que
 * pedimos ao NIF não serviria de nada.
 */
function resolveFolder(registry: RegistryEntry[], claim: LicenseClaim): string {
  const desired = customerFolder(claim.customer, claim.nif);
  const previous = existingFolder(registry, claim.customer, claim.nif);
  if (!previous || previous === desired) return desired;

  const from = path.join(issuerDir(), 'emitidas', previous);
  const to = path.join(issuerDir(), 'emitidas', desired);
  // Destino já ocupado: não fundir pastas às escuras, fica tudo onde está.
  if (existsSync(to)) return previous;
  if (existsSync(from)) renameSync(from, to);

  for (const entry of registry) {
    if (entry.dir !== previous) continue;
    entry.dir = desired;
    entry.file = path.join(to, path.basename(entry.file));
  }
  console.log(`\n  Pasta ${previous} passou a ${desired} (o titular agora tem NIF).`);
  return desired;
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
  // Uma pasta por titular: renovações e reemissões do mesmo cliente acumulam-se
  // no mesmo sítio, em vez de se perderem num monte de LIC-AAAA-NNNN soltos.
  const folder = resolveFolder(registry, claim);
  const outFile = values.out || path.join(issuerDir(), 'emitidas', folder, `${id}.ispmlic`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${token}\n`, 'utf8');

  registry.push({
    id,
    customer: claim.customer,
    ...(claim.nif ? { nif: claim.nif } : {}),
    kind: claim.kind,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt ?? null,
    dir: folder,
    file: outFile
  });
  writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`\n  ${id} — ${claim.customer}`);
  console.log(`  ${claim.kind === 'subscricao' ? `Expira em ${claim.expiresAt}` : `Perpétua, manutenção até ${claim.maintenanceUntil}`}`);
  console.log(`  ${claim.bind === 'machine' ? `Ligada à máquina ${claim.fingerprint}` : 'Chave simples (qualquer máquina)'}`);
  console.log(`  Pasta do titular: ${folder}`);
  console.log(`\n  Ficheiro: ${outFile}\n`);
  if (!claim.nif) {
    console.log('  Sem NIF a pasta fica só pelo nome — dois clientes homónimos partilham-na.');
    console.log('  Reemita com --nif para os separar.\n');
  }
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

// Só despacha quando é ele o programa a correr: importá-lo num teste não
// pode imprimir a ajuda nem emitir nada.
if (process.argv[1]?.includes('issue-license')) {
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
    --nif <nif>             NIF do cliente (9 dígitos, começa por 1 ou 2).
                            Identifica o titular e nomeia a pasta dele.
    --kind <tipo>           subscricao (por omissão) | perpetua
    --bind <modo>           none (por omissão) | machine
    --fingerprint <hash>    obrigatório com --bind machine
    --months <n>            validade ou manutenção, em meses (por omissão 12)
    --grace <n>             dias de tolerância (por omissão 14)
    --id <LIC-AAAA-NNNN>    forçar a referência
    --out <ficheiro>        destino do .ispmlic
                            (por omissão emitidas/<titular>/<referência>.ispmlic)
`);
  }
}

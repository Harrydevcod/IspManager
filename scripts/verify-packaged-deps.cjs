// Falha se alguma dependência de produção (nome@versão) não estiver dentro do app.asar.
// Na 2.77.0 o electron-builder deixou de fora o @peculiar/asn1-schema e o asn1js: são
// peerDependencies do @peculiar/x509 e o coletor dele só segue `dependencies`. A app não abria.
// Percorre o grafo como o Node o resolve: dependencies, optionalDependencies instaladas e
// peers obrigatórios (os opcionais, como o @babel/core do @sentry/bundler-plugins, nunca carregam).
// Uso: node scripts/verify-packaged-deps.cjs [caminho/para/app.asar]
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const archive = path.resolve(process.argv[2] ?? path.join(root, 'release/win-unpacked/resources/app.asar'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Resolução do Node: sobe pelos node_modules a partir da pasta de quem pede.
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === path.dirname(dir)) return null;
  }
}

const need = new Map(); // nome@versão -> quem pediu
const seen = new Set();
(function walk(pkgDir, pkg, chain) {
  const optionalPeers = pkg.peerDependenciesMeta ?? {};
  const wanted = [
    ...Object.keys(pkg.dependencies ?? {}).map((n) => [n, false]),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((n) => [n, true]),
    ...Object.keys(pkg.peerDependencies ?? {}).filter((n) => !optionalPeers[n]?.optional).map((n) => [n, false])
  ];
  for (const [name, optional] of wanted) {
    const file = locate(name, pkgDir);
    if (!file) {
      if (!optional) throw new Error(`${name} não está instalado (pedido por ${chain})`);
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    const dep = readJson(file);
    need.set(`${name}@${dep.version}`, chain);
    walk(path.dirname(file), dep, name);
  }
})(root, readJson(path.join(root, 'package.json')), 'ispm');

const have = new Set();
for (const file of asar.listPackage(archive)) {
  const match = file.replace(/\\/g, '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
  if (!match) continue;
  try {
    const inside = file.replace(/^[\\/]/, ''); // o asar usa o separador do sistema
    have.add(`${match[1]}@${JSON.parse(asar.extractFile(archive, inside).toString('utf8')).version}`);
  } catch {
    // package.json ilegível (fixtures): não conta como pacote.
  }
}

const missing = [...need.keys()].filter((id) => !have.has(id)).sort();
if (missing.length) {
  console.error(
    `Faltam ${missing.length} dependências de produção em ${archive}:\n` +
      missing.map((id) => `  ${id} (pedido por ${need.get(id)})`).join('\n')
  );
  process.exit(1);
}
console.log(`app.asar completo: ${need.size} dependências de produção presentes.`);

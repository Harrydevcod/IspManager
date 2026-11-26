const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function secureMobileIndex(html) {
  if (!/<head(?:\s[^>]*)?>/i.test(html) || /http-equiv\s*=\s*["']content-security-policy/i.test(html)) throw new Error('Unexpected mobile HTML');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]).filter(text => text.trim());
  if (scripts.length !== 1) throw new Error('Unexpected inline scripts in mobile HTML');
  const hash = createHash('sha256').update(scripts[0], 'utf8').digest('base64');
  const policy = [
    "default-src 'none'", `script-src 'self' 'sha256-${hash}'`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'none'",
    "frame-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'"
  ].join('; ');
  return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

function build(output) {
  const repo = path.resolve(__dirname, '..');
  const target = path.resolve(output);
  const allowed = [path.join(repo, 'android-sms-companion', 'app', 'build', 'generated', 'ispmAssets'), path.join(repo, '.scratch')];
  if (!allowed.some(root => { const relative = path.relative(root, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new Error('Invalid mobile output directory');
  const vite = path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [vite, 'build', '--outDir', target], {cwd:repo, stdio:'inherit'});
  if (result.status !== 0) throw new Error('Mobile renderer build failed');
  const index = path.join(target, 'index.html');
  fs.writeFileSync(index, secureMobileIndex(fs.readFileSync(index, 'utf8')), 'utf8');
}

if (require.main === module) {
  try { if (!process.argv[2]) throw new Error('Mobile output directory required'); build(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {secureMobileIndex};

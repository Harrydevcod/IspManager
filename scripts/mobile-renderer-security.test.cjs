const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {secureMobileIndex} = require('./mobile-renderer-security.cjs');

test('permite apenas o script inicial conhecido e bloqueia ligações diretas', () => {
  const script = 'window.ready = true;';
  const html = `<html><head><script>${script}</script><script type="module" src="./app.js"></script></head></html>`;
  const output = secureMobileIndex(html);
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(output.includes(`'sha256-${hash}'`));
  assert.ok(output.includes("connect-src 'none'"));
  assert.ok(output.indexOf('Content-Security-Policy') < output.indexOf('<script>'));
});

test('recusa conteúdo sem bootstrap ou com múltiplos scripts inline', () => {
  assert.throws(() => secureMobileIndex('<html><head></head></html>'));
  assert.throws(() => secureMobileIndex('<head><script>a()</script><script>b()</script></head>'));
});

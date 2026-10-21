import { describe, expect, it } from 'vitest';
import { keepIntegration, scrubBreadcrumb, scrubEvent, scrubText, stripQuery } from './error-reports';

describe('relatórios de erro: nada de clientes sai', () => {
  it('tira e-mails, NIF, telefones e números de conta do texto', () => {
    expect(scrubText('Falhou para maria@skynet.cv NIF 123456789 tel 991 23 45')).toBe(
      'Falhou para [email] NIF [número] tel [número]'
    );
    expect(scrubText('HTTP 500 em 3 tentativas')).toBe('HTTP 500 em 3 tentativas');
    expect(scrubText('connect ECONNREFUSED 192.168.2.1:443')).toBe('connect ECONNREFUSED 192.168.2.1:443');
    // Medido no smoke de 2026-10-21: a data do título saía como [número].
    expect(scrubText('fatura de 2026-10-21')).toBe('fatura de 2026-10-21');
  });

  it('tira o nome da conta do Windows dos caminhos', () => {
    expect(scrubText("ENOENT: open 'C:\\Users\\Maria Silva\\AppData\\ISPM\\x.yml'")).toBe(
      "ENOENT: open 'C:\\Users\\[utilizador]\\AppData\\ISPM\\x.yml'"
    );
    expect(scrubText('em c:/users/arydson/Downloads/ispm')).toBe('em c:/users/[utilizador]/Downloads/ispm');
  });

  it('corta query e fragmento dos URLs', () => {
    expect(stripQuery('http://127.0.0.1:3001/api/clients?search=Maria')).toBe('http://127.0.0.1:3001/api/clients');
    expect(stripQuery('file:///app/index.html#/clientes/7')).toBe('file:///app/index.html');
  });

  it('larga as integrações que levam memória, ecrã, consola ou variáveis', () => {
    for (const name of ['SentryMinidump', 'ElectronMinidump', 'Screenshots', 'Console', 'LocalVariables']) {
      expect(keepIntegration(name)).toBe(false);
    }
    for (const name of ['OnUncaughtException', 'ElectronBreadcrumbs', 'LinkedErrors', 'Breadcrumbs']) {
      expect(keepIntegration(name)).toBe(true);
    }
  });

  it('larga o texto escrito e limpa os URLs dos breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'ui.input', message: 'Maria' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'console', message: 'cliente Maria' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'button "Maria Silva"' })).toEqual({ category: 'ui.click', data: undefined });
    expect(
      scrubBreadcrumb({
        category: 'navigation',
        data: { from: '/clientes?q=Maria', to: 'https://x/#access_token=abc', 'url.query': 'q=Maria' }
      })
    ).toEqual({ category: 'navigation', data: { from: '/clientes', to: 'https://x/' } });
  });

  it('limpa o evento inteiro: mensagem, exceção, pedido, utilizador e spans', () => {
    const event = scrubEvent({
      message: 'cliente 991234567',
      user: { email: 'a@b.cv' },
      server_name: 'PC-DO-ISP',
      extra: { body: 'tudo' },
      exception: { values: [{ value: 'UNIQUE falhou: 123456789' }] },
      request: { url: '/api/x?nif=123456789', query_string: 'nif=123456789', data: '{}', headers: { a: 'b' }, cookies: 'c' },
      breadcrumbs: [{ category: 'ui.input' }, { category: 'fetch', data: { url: '/api/clients?search=Ana' } }],
      spans: [{ description: 'GET http://127.0.0.1:3001/api/clients?search=Ana', data: { 'http.url': '/api/clients?search=Ana' } }]
    });
    expect(event).toEqual({
      message: 'cliente [número]',
      exception: { values: [{ value: 'UNIQUE falhou: [número]' }] },
      request: { url: '/api/x' },
      breadcrumbs: [{ category: 'fetch', data: { url: '/api/clients' } }],
      spans: [{ description: 'GET http://127.0.0.1:3001/api/clients', data: { 'http.url': '/api/clients' } }]
    });
  });
});

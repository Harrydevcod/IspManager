import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { IptvPanel } from './IptvPanel';
import type { IptvStatus } from '../iptv/iptv-api';
import type { ServiceRow } from '../../types';

const live = <T,>(data: T | null, error: string | null = null) => ({ data, error, reload: () => {} });

const dryRun: IptvStatus = {
  targets: [
    { serviceId: 1, source: { kind: 'pppoe', username: 'skn014', legacy: null } },
    { serviceId: 2, source: { kind: 'missing', reason: 'Falta o MAC do router do cliente' } }
  ],
  last: {
    status: 'dry_run',
    users: ['skn014'], macs: [], missing: [],
    active: [{ serviceId: 1, via: 'pppoe', address: '10.20.0.9' }, { serviceId: 2, via: null }],
    manualConflicts: [],
    unownedManual: [{ address: '192.168.2.226', comment: 'Cliente antigo' }],
    foreignManual: [],
    serversCovered: [],
    before: null,
    servers: { added: 2, removed: 0, renamed: 0, reactivated: 0 }
  }
};

const services = [{ id: 1, clientName: 'Chia' }, { id: 2, clientName: 'Gemada' }] as ServiceRow[];

const render = (status: IptvStatus, infraError: string | null = null) => renderToStaticMarkup(
  <IptvPanel status={live(status)} infra={live(null, infraError)} providers={live([])} services={services} isAdmin />
);

describe('IptvPanel', () => {
  test('em ensaio mostra o que mudaria, por onde cada cliente entra e a entrada manual obsoleta', () => {
    const html = render(dryRun);
    expect(html).toContain('Em ensaio: nada foi escrito');
    expect(html).toContain('+ PPPoE skn014');
    expect(html).toContain('2 servidor(es) a acrescentar');
    expect(html).toContain('10.20.0.9');
    expect(html).toContain('Falta o MAC do router do cliente');
    expect(html).toContain('Obsoleta: ninguém tem este IP');
  });

  test('fora da rede, a infraestrutura diz porquê e o resto continua à vista', () => {
    const html = render(dryRun, 'Fora da rede de gestão.');
    expect(html).toContain('Fora da rede de gestão.');
    expect(html).toContain('Chia');
  });

  test('sem serviços marcados nem passagem', () => {
    const html = render({ targets: [], last: null });
    expect(html).toContain('Nenhum serviço com IPTV via VPN');
    expect(html).toContain('ainda não fez nenhuma passagem');
  });
});

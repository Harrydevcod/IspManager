import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { IptvTunnels } from './IptvTunnels';
import type { IptvTunnels as Tunnels } from '../iptv/iptv-api';

const live = <T,>(data: T | null, error: string | null = null) => ({ data, error, reload: () => {} });
// Nomes inventados: o ecrã mostra os do router, sejam quais forem.
const data: Tunnels = {
  tunnels: [
    { name: 'tun-a', type: 'wg', alive: true, detail: 'tun-a: último handshake há 30s', inUse: true, ready: true, reasons: [] },
    { name: 'tun-b', type: 'ovpn-out', alive: true, detail: 'tun-b (ovpn-out): a correr', inUse: false, ready: true, reasons: [] },
    { name: 'tun-c', type: 'gre-tunnel', alive: true, detail: 'tun-c (gre-tunnel): a correr', inUse: false, ready: false, reasons: ['Sem NAT pelo túnel'] }
  ]
};

test('mostra os túneis com o nome do router, o em uso e o que falta, sem nada para configurar', () => {
  const html = renderToStaticMarkup(<IptvTunnels tunnels={live(data)} />);
  expect(html).toContain('tun-a');
  expect(html).toContain('ovpn-out');
  expect(html).toContain('Em uso pelo IPTV');
  expect(html).toContain('Sem NAT pelo túnel');
  expect(html).toContain('último handshake há 30s');
  // Só informa: nenhuma acção de escolher ou aplicar um túnel (os botões que há são os de ordenar colunas).
  expect(html).not.toMatch(/Usar|Escolh|Deixar de gerir|Aplicar/);
});

test('fora da rede diz porquê; sem túneis diz onde se configuram', () => {
  expect(renderToStaticMarkup(<IptvTunnels tunnels={live(null, 'Fora da rede de gestão.')} />)).toContain('Fora da rede de gestão.');
  expect(renderToStaticMarkup(<IptvTunnels tunnels={live({ tunnels: [] })} />)).toContain('Sem túneis no router');
});

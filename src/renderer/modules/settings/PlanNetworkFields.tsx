import { useState } from 'react';
import { Button, RouterChoice, type RouterOptions } from '../../components';
import { authFetch } from '../../lib/auth';
import type { SettingsFormState, UpdateField } from './settingsForm';

type ProfileNetwork = {
  localAddress: string | null;
  remoteAddress: string | null;
  dnsServer: string | null;
  interfaceList: string | null;
  parentQueue: string | null;
};
type ProfilesResponse = { available: boolean; reason?: string; profiles: Array<{ name: string; network?: ProfileNetwork }> };

/**
 * Os campos de rede que todo o perfil de plano criado pelo ISPM leva (ADR 0011). Sem eles o
 * cliente liga-se sem IP e fora das regras da firewall. "Ler do perfil" copia-os de um perfil do router
 * (por omissão o perfil-base) para o formulário; só ficam valendo depois de gravar.
 */
export function PlanNetworkFields({ form, onUpdate, options, onReload }: {
  form: SettingsFormState; onUpdate: UpdateField; options: RouterOptions; onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('');
  // Por omissão o perfil-base, mas o `default` do RouterOS não tem endereços: o operador escolhe
  // um perfil que já dá rede aos clientes.
  const base = source || form.routerosBaseProfile?.trim() || 'default';

  async function readFromRouter() {
    setBusy(true);
    setMessage('');
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/network/router/profiles');
      const body = (await response.json()) as ProfilesResponse;
      if (!body.available) {
        setMessage(body.reason ?? 'Router indisponível.');
        return;
      }
      const network = body.profiles.find((profile) => profile.name === base)?.network;
      if (!network) {
        setMessage(`O perfil ${base} não existe no router.`);
        return;
      }
      onUpdate('routerosPppLocalAddress', network.localAddress ?? '');
      onUpdate('routerosPppRemotePool', network.remoteAddress ?? '');
      onUpdate('routerosPppInterfaceList', network.interfaceList ?? '');
      onUpdate('routerosPppDns', network.dnsServer ?? '');
      onUpdate('routerosPppParentQueue', network.parentQueue ?? '');
      const empty = Object.values(network).filter((value) => !value).length;
      setMessage(empty > 0
        ? `Lido de ${base}, mas ${empty} campo(s) vêm vazios: complete-os antes de gravar.`
        : `Lido de ${base}. Confira e grave.`);
    } catch {
      setMessage('Não foi possível ler os perfis do router.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-router-cert wide-field">
        <span className="field-label">Rede dos perfis dos planos</span>
        <p>
          Todo o perfil que o ISPM cria ou corrige leva estes campos e <code>only-one=yes</code>. Se faltar algum,
          o perfil não é criado e o plano fica pendente.
        </p>
        <div className="settings-profile-source">
          <RouterChoice label="Perfil de onde ler" value={base} onChange={setSource} options={options} list="profiles" noun="perfis PPP" />
          <Button variant="secondary" onClick={() => void readFromRouter()} disabled={busy || options.status !== 'ready'}>
            {busy ? 'A ler…' : `Ler do perfil ${base}`}
          </Button>
          <Button variant="ghost" onClick={onReload} disabled={options.status === 'loading'}>Ler de novo</Button>
        </div>
        {message && <p role="status">{message}</p>}
      </div>
      <RouterChoice label="Gateway PPPoE (local-address)" value={form.routerosPppLocalAddress} options={options}
        list="localAddresses" noun="endereços" onChange={(value) => onUpdate('routerosPppLocalAddress', value)} />
      <RouterChoice label="Pool de endereços (remote-address)" value={form.routerosPppRemotePool} options={options}
        list="pools" noun="pools" onChange={(value) => onUpdate('routerosPppRemotePool', value)} />
      <RouterChoice label="Lista de interfaces (interface-list)" value={form.routerosPppInterfaceList} options={options}
        list="interfaceLists" noun="interface-lists" onChange={(value) => onUpdate('routerosPppInterfaceList', value)}
        hint="A lista que as regras da firewall dos clientes usam." />
      <RouterChoice label="DNS (dns-server)" value={form.routerosPppDns} options={options} list="dnsServers" noun="endereços"
        emptyLabel="O gateway" onChange={(value) => onUpdate('routerosPppDns', value)} />
      <RouterChoice label="Fila-mãe (parent-queue)" value={form.routerosPppParentQueue} options={options}
        list="queues" noun="filas" onChange={(value) => onUpdate('routerosPppParentQueue', value)} />
    </>
  );
}

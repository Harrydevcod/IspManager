import { Route } from 'lucide-react';
import { Badge, DataTable, EmptyState, Message, SkeletonList, type DataTableColumn } from '../../components';
import type { IptvTunnel, IptvTunnels as Tunnels } from '../iptv/iptv-api';

type Live<T> = { data: T | null; error: string | null; reload: () => void };

/**
 * Os túneis que o router tem, com o nome que lá têm. Só informa: a VPN, de qualquer
 * fornecedor, configura-se no router, e o IPTV segue a rota da tabela do IPTV.
 */
export function IptvTunnels({ tunnels }: { tunnels: Live<Tunnels> }) {
  const columns: DataTableColumn<IptvTunnel>[] = [
    { header: 'Túnel', sortValue: (row) => row.name, cell: (row) => <strong>{row.name}</strong> },
    { header: 'Tipo', sortValue: (row) => row.type, cell: (row) => <code>{row.type}</code> },
    // O detalhe vem como "nome: estado"; o nome já tem coluna própria.
    { header: 'Estado', sortValue: (row) => row.detail, cell: (row) => <span className={row.alive ? undefined : 'router-muted'}>{row.detail.slice(row.detail.indexOf(': ') + 2)}</span> },
    {
      header: 'Situação',
      sortValue: (row) => (row.inUse ? 0 : row.ready ? 1 : 2),
      cell: (row) => row.inUse ? <Badge tone="success">Em uso pelo IPTV</Badge>
        : row.ready ? <Badge tone="info">Pronto</Badge>
        : <Badge tone="warn">{row.reasons.join(' · ')}</Badge>
    }
  ];

  return (
    <section className="router-findings" aria-label="VPN do IPTV">
      <h3><Route size={16} aria-hidden /> VPN do IPTV</h3>
      <p className="router-muted">Qualquer VPN serve: configure-a no router e aparece aqui com o nome que lá tem. O IPTV segue a rota da tabela do IPTV.</p>
      {tunnels.error ? <Message tone="neutral">{tunnels.error}</Message>
        : !tunnels.data ? <SkeletonList rows={2} />
        : (
          <DataTable
            rows={tunnels.data.tunnels}
            rowKey={(row) => row.name}
            columns={columns}
            gridTemplateColumns="minmax(8rem, 1fr) 7rem minmax(10rem, 1.5fr) minmax(9rem, 1.4fr)"
            empty={<EmptyState size="sm" icon={Route} title="Sem túneis no router" description="Configure a VPN no router; aparece aqui com o nome que lá tiver." />}
          />
        )}
    </section>
  );
}

import { useState } from 'react';
import { Badge, DataTable, Dialog, EmptyState, ErrorRetry, SkeletonList, type DataTableColumn } from '../../components';
import { formatPtDateTime } from '../../lib/format';
import { useLive } from '../router/useLive';

export type IncidentClient = { clientId: number; clientCode: string; clientName: string; zone: string | null };

export type NetworkIncident = {
  key: string;
  backboneDeviceId: number;
  name: string;
  zone: string | null;
  status: 'open' | 'resolved' | 'unknown';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  draggedDevices: string[];
  clients: IncidentClient[];
};

export type IncidentsResponse = { probeEnabled: boolean; windowDays: number; incidents: NetworkIncident[] };

const INCIDENTS_URL = 'http://127.0.0.1:3001/api/network/incidents';

const STATUS: Record<NetworkIncident['status'], { label: string; tone: 'danger' | 'success' | 'neutral'; order: number }> = {
  open: { label: 'Em curso', tone: 'danger', order: 0 },
  // A aplicação esteve fechada: sabe-se que voltou, não se sabe quando.
  unknown: { label: 'Fim por observar', tone: 'neutral', order: 1 },
  resolved: { label: 'Resolvido', tone: 'success', order: 2 }
};

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'Desconhecida';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

const columns: DataTableColumn<NetworkIncident>[] = [
  { header: 'Estado', sortValue: (row) => STATUS[row.status].order, cell: (row) => <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge> },
  { header: 'Equipamento', sortValue: (row) => row.name, cell: (row) => <strong>{row.name}</strong> },
  { header: 'Zona', sortValue: (row) => row.zone ?? '', cell: (row) => row.zone ?? '—' },
  { header: 'Início', sortValue: (row) => row.startedAt, defaultDirection: 'desc', cell: (row) => formatPtDateTime(row.startedAt) },
  { header: 'Fim', sortValue: (row) => row.endedAt ?? '', defaultDirection: 'desc', cell: (row) => row.status === 'resolved' ? formatPtDateTime(row.endedAt) : '—' },
  { header: 'Duração', sortValue: (row) => row.durationSeconds ?? -1, defaultDirection: 'desc', align: 'end', cell: (row) => formatDuration(row.durationSeconds) },
  { header: 'Clientes afetados', sortValue: (row) => row.clients.length, defaultDirection: 'desc', align: 'end', cell: (row) => row.clients.length },
  { header: 'Arrastou', sortValue: (row) => row.draggedDevices.length, defaultDirection: 'desc', align: 'end', cell: (row) => row.draggedDevices.length }
];

const clientColumns: DataTableColumn<IncidentClient>[] = [
  { header: 'Código', sortValue: (row) => row.clientCode, cell: (row) => row.clientCode },
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => row.clientName },
  { header: 'Zona', sortValue: (row) => row.zone ?? '', cell: (row) => row.zone ?? '—' }
];

export function IncidentsWorkspace({ active }: { active: boolean }) {
  const live = useLive<IncidentsResponse>(INCIDENTS_URL, active, 60_000);
  const [selected, setSelected] = useState<NetworkIncident | null>(null);

  if (live.error && !live.data) return <ErrorRetry message="Não foi possível ler os incidentes." onRetry={live.reload} />;
  if (!live.data) return <SkeletonList rows={5} />;

  return (
    <section className="module-panel" aria-label="Incidentes do backbone">
      {/* O servidor já devolve os abertos primeiro; a tabela só reordena a pedido. */}
      <DataTable rows={live.data.incidents} rowKey={(row) => row.key} columns={columns}
        onRowClick={setSelected} activeKey={selected?.key ?? null}
        gridTemplateColumns="132px minmax(150px, 1.4fr) minmax(100px, 1fr) 136px 136px 104px 132px 88px"
        empty={live.data.probeEnabled
          ? <EmptyState title="Sem incidentes" description={`Nenhum equipamento do backbone caiu nos últimos ${live.data.windowDays} dias de observação.`} />
          : <EmptyState title="Sonda de rede desligada" description="Os incidentes vêm da sonda. Ligue-a em Definições para os começar a registar." />} />

      <Dialog open={selected !== null} onClose={() => setSelected(null)} size="lg"
        eyebrow={selected ? `${STATUS[selected.status].label} · ${formatPtDateTime(selected.startedAt)} · ${formatDuration(selected.durationSeconds)}` : undefined}
        title={selected?.name ?? ''}>
        {selected && (
          <>
            {selected.draggedDevices.length > 0 && <p>Arrastou: {selected.draggedDevices.join(', ')}</p>}
            {/* Quem pende do equipamento hoje; a ligação pode ter mudado desde o incidente. */}
            <DataTable rows={selected.clients} rowKey={(row) => row.clientId} columns={clientColumns}
              gridTemplateColumns="88px minmax(160px, 1.5fr) minmax(100px, 1fr)"
              defaultSort={{ key: 'Código', direction: 'asc' }}
              empty={<EmptyState title="Sem clientes ligados" description="Nenhum serviço ativo pende deste equipamento." />} />
          </>
        )}
      </Dialog>
    </section>
  );
}

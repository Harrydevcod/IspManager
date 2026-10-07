import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, SkeletonList, type DataTableColumn } from '../../components';
import { useAuth } from '../../lib/auth';
import { formatPtDateTime } from '../../lib/format';
import { useLive } from '../router/useLive';
import { NetworkDiaryDialog } from './NetworkDiaryDialog';
import { findingWho, formatLocalStamp, KIND_LABEL, NETWORK_API, type DiaryEntry, type HealthFinding, type NetworkHealth } from './network-health';

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

const INCIDENTS_URL = `${NETWORK_API}/incidents`;
/** A aba mostra uma semana do registo do router; o cartão do painel fica pelas 72 horas. */
const FINDINGS_HOURS = 24 * 7;

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

const findingColumns: DataTableColumn<HealthFinding>[] = [
  { header: 'Tipo', sortValue: (row) => KIND_LABEL[row.kind], cell: (row) => <strong>{KIND_LABEL[row.kind]}</strong> },
  { header: 'Endereço', sortValue: (row) => row.subject, cell: (row) => row.subject },
  { header: 'Pertence a', sortValue: (row) => findingWho(row), cell: (row) => findingWho(row) },
  { header: 'Detalhe', sortValue: (row) => row.label, cell: (row) => row.label || '—' },
  { header: 'Ocorrências', sortValue: (row) => row.count, defaultDirection: 'desc', align: 'end', cell: (row) => row.count },
  { header: 'Primeira vez', sortValue: (row) => row.firstAt, defaultDirection: 'desc', cell: (row) => formatLocalStamp(row.firstAt) },
  { header: 'Última vez', sortValue: (row) => row.lastAt, defaultDirection: 'desc', cell: (row) => formatLocalStamp(row.lastAt) }
];

const diaryColumns: DataTableColumn<DiaryEntry>[] = [
  { header: 'Estado', sortValue: (row) => row.status, cell: (row) => <Badge tone={row.status === 'aberta' ? 'warn' : 'success'}>{row.status === 'aberta' ? 'Aberta' : 'Resolvida'}</Badge> },
  { header: 'Quando', sortValue: (row) => row.happenedAt, defaultDirection: 'desc', cell: (row) => formatLocalStamp(row.happenedAt) },
  { header: 'Situação', sortValue: (row) => row.title, cell: (row) => <strong>{row.title}</strong> },
  { header: 'Causa', sortValue: (row) => row.cause, cell: (row) => row.cause || '—' },
  { header: 'Resolução', sortValue: (row) => row.resolution, cell: (row) => row.resolution || '—' }
];

type View = 'outages' | 'router' | 'diary';
const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'outages', label: 'Quedas' },
  { id: 'router', label: 'Router' },
  { id: 'diary', label: 'Diário' }
];

function OutagesView({ active }: { active: boolean }) {
  const live = useLive<IncidentsResponse>(INCIDENTS_URL, active, 60_000);
  const [selected, setSelected] = useState<NetworkIncident | null>(null);

  if (live.error && !live.data) return <ErrorRetry message="Não foi possível ler os incidentes." onRetry={live.reload} />;
  if (!live.data) return <SkeletonList rows={5} />;

  return (
    <>
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
    </>
  );
}

/** O que o registo do router contou: o ISPM lê-o de 5 em 5 minutos enquanto está aberto. */
function RouterFindingsView({ active }: { active: boolean }) {
  const live = useLive<NetworkHealth>(`${NETWORK_API}/health?hours=${FINDINGS_HOURS}`, active, 60_000);

  if (live.error && !live.data) return <ErrorRetry message="Não foi possível ler os achados do router." onRetry={live.reload} />;
  if (!live.data) return <SkeletonList rows={5} />;

  return (
    <DataTable rows={live.data.findings} rowKey={(row) => `${row.kind}:${row.subject}`} columns={findingColumns}
      gridTemplateColumns="minmax(170px, 1.2fr) 150px minmax(120px, 1fr) minmax(120px, 1fr) 104px 132px 132px"
      empty={live.data.lastRouterReadAt
        ? <EmptyState title="Sem achados" description="O registo do router não assinalou nada nos últimos 7 dias." />
        : <EmptyState title="Registo do router por ler" description="Os achados aparecem depois da primeira leitura, com o ISPM na rede de gestão." />} />
  );
}

function DiaryView({ active }: { active: boolean }) {
  const live = useLive<DiaryEntry[]>(`${NETWORK_API}/diary`, active, 60_000);
  const { user } = useAuth();
  const canWrite = !user || ['admin', 'operator'].includes(user.role);
  // `null` cria; uma ocorrência edita; `undefined` é o diálogo fechado.
  const [editing, setEditing] = useState<DiaryEntry | null | undefined>(undefined);

  if (live.error && !live.data) return <ErrorRetry message="Não foi possível ler o diário." onRetry={live.reload} />;
  if (!live.data) return <SkeletonList rows={5} />;

  return (
    <>
      {canWrite && (
        <div className="incidents-actions">
          <Button leadingIcon={<Plus size={16} aria-hidden />} onClick={() => setEditing(null)}>Nova ocorrência</Button>
        </div>
      )}
      <DataTable rows={live.data} rowKey={(row) => row.id} columns={diaryColumns}
        onRowClick={canWrite ? setEditing : undefined}
        gridTemplateColumns="112px 136px minmax(180px, 1.4fr) minmax(140px, 1fr) minmax(140px, 1fr)"
        empty={<EmptyState title="Diário vazio" description="Registe aqui o que aconteceu na rede, a causa e como se resolveu." />} />
      <NetworkDiaryDialog open={editing !== undefined} entry={editing} onClose={() => setEditing(undefined)}
        onSaved={() => { setEditing(undefined); live.reload(); }} />
    </>
  );
}

export function IncidentsWorkspace({ active }: { active: boolean }) {
  const [view, setView] = useState<View>('outages');

  return (
    <section className="module-panel" aria-label="Incidentes do backbone">
      <nav className="segmented-tabs" role="tablist" aria-label="Vistas dos incidentes">
        {VIEWS.map((item) => (
          <Button key={item.id} variant="ghost" role="tab" aria-selected={view === item.id}
            className={`segmented-tab${view === item.id ? ' is-active' : ''}`} onClick={() => setView(item.id)}>
            {item.label}
          </Button>
        ))}
      </nav>
      {/* Só a vista à mostra faz pedidos. */}
      {view === 'outages' && <OutagesView active={active} />}
      {view === 'router' && <RouterFindingsView active={active} />}
      {view === 'diary' && <DiaryView active={active} />}
    </section>
  );
}

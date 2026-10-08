import { useState, type ReactNode } from 'react';
import { HardDrive, NotebookPen, Plus, Radar, ScrollText, ShieldCheck } from 'lucide-react';
import { Badge, Button, DataTable, Dialog, EmptyState, ErrorRetry, Message, SkeletonList, type DataTableColumn } from '../../components';
import { useAuth } from '../../lib/auth';
import { formatPtDateTime } from '../../lib/format';
import { useLive } from '../router/useLive';
import { NetworkDiaryDialog } from './NetworkDiaryDialog';
import { findingTone, findingWho, formatLocalStamp, KIND_LABEL, NETWORK_API, networkRequest, type DiaryEntry, type HealthFinding, type NetworkHealth } from './network-health';

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

/** Dia e hora sem o ano, como as horas do router na vista ao lado: a janela é de dias e a coluna fica estreita. */
const shortStamp = (value: string | null) => formatPtDateTime(value).replace(/-(\d{2})-\d{4},/, '/$1');

const columns: DataTableColumn<NetworkIncident>[] = [
  { header: 'Estado', sortValue: (row) => STATUS[row.status].order, cell: (row) => <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge> },
  { header: 'Equipamento', sortValue: (row) => row.name, cell: (row) => <strong>{row.name}</strong> },
  { header: 'Zona', sortValue: (row) => row.zone ?? '', cell: (row) => row.zone ?? '—' },
  { header: 'Início', sortValue: (row) => row.startedAt, defaultDirection: 'desc', cell: (row) => shortStamp(row.startedAt) },
  { header: 'Fim', sortValue: (row) => row.endedAt ?? '', defaultDirection: 'desc', cell: (row) => row.status === 'resolved' ? shortStamp(row.endedAt) : '—' },
  { header: 'Duração', sortValue: (row) => row.durationSeconds ?? -1, defaultDirection: 'desc', align: 'end', cell: (row) => row.status === 'open' ? <span className="incidents-ongoing">{formatDuration(row.durationSeconds)}</span> : formatDuration(row.durationSeconds) },
  { header: 'Clientes', sortValue: (row) => row.clients.length, defaultDirection: 'desc', align: 'end', cell: (row) => row.clients.length },
  { header: 'Arrastou', sortValue: (row) => row.draggedDevices.length, defaultDirection: 'desc', align: 'end', cell: (row) => row.draggedDevices.length }
];

const clientColumns: DataTableColumn<IncidentClient>[] = [
  { header: 'Código', sortValue: (row) => row.clientCode, cell: (row) => row.clientCode },
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => row.clientName },
  { header: 'Zona', sortValue: (row) => row.zone ?? '', cell: (row) => row.zone ?? '—' }
];

const findingColumns: DataTableColumn<HealthFinding>[] = [
  // Sem negrito: o negrito corta com reticências, e "Endereço do router duplicado" tem de se ler inteiro.
  { header: 'Tipo', sortValue: (row) => KIND_LABEL[row.kind], cell: (row) => <span className="incidents-kind" data-tone={findingTone(row.kind)}>{KIND_LABEL[row.kind]}</span> },
  { header: 'Endereço', sortValue: (row) => row.subject, className: 'incidents-num', cell: (row) => row.subject },
  { header: 'Pertence a', sortValue: (row) => findingWho(row), cell: (row) => findingWho(row) },
  { header: 'Detalhe', sortValue: (row) => row.label, cell: (row) => row.label || '—' },
  { header: 'Vezes', sortValue: (row) => row.count, defaultDirection: 'desc', align: 'end', cell: (row) => row.count },
  { header: 'Desde', sortValue: (row) => row.firstAt, defaultDirection: 'desc', cell: (row) => formatLocalStamp(row.firstAt, false) },
  { header: 'Última vez', sortValue: (row) => row.lastAt, defaultDirection: 'desc', cell: (row) => formatLocalStamp(row.lastAt, false) }
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

type ViewProps = { active: boolean; tabs: ReactNode };

/** Uma só linha por cima da tabela: as vistas à esquerda, o contexto e a ação da vista à direita. */
function Bar({ tabs, meta, action }: { tabs: ReactNode; meta?: string; action?: ReactNode }) {
  return (
    <div className="incidents-bar">
      {tabs}
      <div className="incidents-bar-side">
        {meta && <span className="incidents-meta">{meta}</span>}
        {action}
      </div>
    </div>
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function OutagesView({ active, tabs }: ViewProps) {
  const live = useLive<IncidentsResponse>(INCIDENTS_URL, active, 60_000);
  const [selected, setSelected] = useState<NetworkIncident | null>(null);

  if (!live.data) {
    return (
      <>
        <Bar tabs={tabs} />
        {live.error ? <ErrorRetry message="Não foi possível ler os incidentes." onRetry={live.reload} /> : <SkeletonList rows={5} />}
      </>
    );
  }

  const open = live.data.incidents.filter((row) => row.status === 'open').length;

  return (
    <>
      <Bar tabs={tabs} meta={live.data.probeEnabled
        ? `${open > 0 ? `${open} em curso` : 'Nenhuma em curso'} · últimos ${live.data.windowDays} dias`
        : 'Sonda desligada'} />
      {/* O servidor já devolve os abertos primeiro; a tabela só reordena a pedido. */}
      <DataTable stickyHeader rows={live.data.incidents} rowKey={(row) => row.key} columns={columns}
        onRowClick={setSelected} activeKey={selected?.key ?? null}
        // Cabe nos 918 px que a aba tem no ecrã de 1920 a 150%.
        gridTemplateColumns="132px minmax(110px, 1.6fr) minmax(80px, 1fr) 98px 98px 96px 80px 80px"
        empty={live.data.probeEnabled
          ? <EmptyState icon={ShieldCheck} title="Sem incidentes" description={`Nenhum equipamento do backbone caiu nos últimos ${live.data.windowDays} dias de observação.`} />
          : <EmptyState icon={Radar} title="Sonda de rede desligada" description="Os incidentes vêm da sonda. Ligue-a em Definições para os começar a registar." />} />

      <Dialog open={selected !== null} onClose={() => setSelected(null)} size="lg"
        eyebrow={selected ? `${STATUS[selected.status].label} · ${formatPtDateTime(selected.startedAt)} · ${formatDuration(selected.durationSeconds)}` : undefined}
        title={selected?.name ?? ''}>
        {selected && (
          <div className="incidents-detail">
            {selected.draggedDevices.length > 0 && (
              <p className="incidents-dragged"><span className="field-label">Arrastou</span> {selected.draggedDevices.join(', ')}</p>
            )}
            {/* Quem pende do equipamento hoje; a ligação pode ter mudado desde o incidente. */}
            <DataTable rows={selected.clients} rowKey={(row) => row.clientId} columns={clientColumns}
              gridTemplateColumns="88px minmax(160px, 1.5fr) minmax(100px, 1fr)"
              defaultSort={{ key: 'Código', direction: 'asc' }}
              empty={<EmptyState title="Sem clientes ligados" description="Nenhum serviço ativo pende deste equipamento." />} />
          </div>
        )}
      </Dialog>
    </>
  );
}

/**
 * O que o registo do router contou: o ISPM lê-o de 5 em 5 minutos enquanto está aberto. Com o
 * diário no cartão, o que aconteceu com ele fechado conta-se na leitura seguinte.
 */
function RouterFindingsView({ active, tabs }: ViewProps) {
  const live = useLive<NetworkHealth>(`${NETWORK_API}/health?hours=${FINDINGS_HOURS}`, active, 60_000);

  if (!live.data) {
    return (
      <>
        <Bar tabs={tabs} />
        {live.error ? <ErrorRetry message="Não foi possível ler os achados do router." onRetry={live.reload} /> : <SkeletonList rows={5} />}
      </>
    );
  }

  return (
    <>
      <Bar tabs={tabs}
        meta={live.data.lastRouterReadAt
          ? `Lido a ${shortStamp(live.data.lastRouterReadAt)} · últimos 7 dias${live.data.routerJournal ? ' · registo no cartão' : ''}`
          : 'Registo por ler'}
        action={!live.data.routerJournal && <JournalInstall active={active} onInstalled={live.reload} />} />
      <DataTable stickyHeader rows={live.data.findings} rowKey={(row) => `${row.kind}:${row.subject}`} columns={findingColumns}
        // Cabe nos 857 px que a tabela tem no ecrã de 1920 a 150%.
        gridTemplateColumns="minmax(128px, 1.2fr) 138px minmax(100px, 1fr) minmax(88px, 0.8fr) 56px 98px 98px"
        empty={live.data.lastRouterReadAt
          ? <EmptyState icon={ShieldCheck} title="Sem achados" description="O registo do router não assinalou nada nos últimos 7 dias." />
          : <EmptyState icon={ScrollText} title="Registo do router por ler" description="Os achados aparecem depois da primeira leitura, com o ISPM na rede de gestão." />} />
    </>
  );
}

type JournalStatus = { installed: string | null; available: boolean; disks?: Array<{ slot: string }> };

/**
 * Sem diário, o router só guarda 1000 linhas em memória e perde-as ao reiniciar. Com um cartão
 * no router, o botão põe-no a escrever lá o registo; quem não é administrador recebe 403 e não vê nada.
 */
function JournalInstall({ active, onInstalled }: { active: boolean; onInstalled: () => void }) {
  const status = useLive<JournalStatus>(`${NETWORK_API}/router/log-journal`, active, 600_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disk = status.data?.disks?.[0]?.slot;
  if (!disk) return null;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await networkRequest('/router/log-journal', { method: 'POST', body: { disk } });
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível ligar o diário.');
      setBusy(false);
    }
  };

  return (
    <>
      {error && <Message tone="error">{error}</Message>}
      <Button variant="secondary" size="sm" leadingIcon={<HardDrive size={16} aria-hidden />} disabled={busy} onClick={() => { void install(); }}
        title="O router passa a escrever o registo no cartão; o ISPM lê o que aconteceu com ele fechado.">
        Guardar o registo no cartão ({disk})
      </Button>
    </>
  );
}

function DiaryView({ active, tabs }: ViewProps) {
  const live = useLive<DiaryEntry[]>(`${NETWORK_API}/diary`, active, 60_000);
  const { user } = useAuth();
  const canWrite = !user || ['admin', 'operator'].includes(user.role);
  // `null` cria; uma ocorrência edita; `undefined` é o diálogo fechado.
  const [editing, setEditing] = useState<DiaryEntry | null | undefined>(undefined);

  if (!live.data) {
    return (
      <>
        <Bar tabs={tabs} />
        {live.error ? <ErrorRetry message="Não foi possível ler o diário." onRetry={live.reload} /> : <SkeletonList rows={5} />}
      </>
    );
  }

  const open = live.data.filter((row) => row.status === 'aberta').length;

  return (
    <>
      <Bar tabs={tabs}
        meta={live.data.length > 0 ? `${plural(open, 'aberta', 'abertas')} · ${plural(live.data.length, 'ocorrência', 'ocorrências')}` : undefined}
        action={canWrite && <Button size="sm" leadingIcon={<Plus size={16} aria-hidden />} onClick={() => setEditing(null)}>Nova ocorrência</Button>} />
      <DataTable stickyHeader rows={live.data} rowKey={(row) => row.id} columns={diaryColumns}
        onRowClick={canWrite ? setEditing : undefined}
        gridTemplateColumns="112px 136px minmax(180px, 1.4fr) minmax(140px, 1fr) minmax(140px, 1fr)"
        empty={<EmptyState icon={NotebookPen} title="Diário vazio" description="Registe aqui o que aconteceu na rede, a causa e como se resolveu." />} />
      <NetworkDiaryDialog open={editing !== undefined} entry={editing} onClose={() => setEditing(undefined)}
        onSaved={() => { setEditing(undefined); live.reload(); }} />
    </>
  );
}

export function IncidentsWorkspace({ active }: { active: boolean }) {
  const [view, setView] = useState<View>('outages');

  const tabs = (
    <nav className="segmented-tabs" role="tablist" aria-label="Vistas dos incidentes">
      {VIEWS.map((item) => (
        <Button key={item.id} variant="ghost" role="tab" aria-selected={view === item.id}
          className={`segmented-tab${view === item.id ? ' is-active' : ''}`} onClick={() => setView(item.id)}>
          {item.label}
        </Button>
      ))}
    </nav>
  );

  return (
    <section className="incidents-workspace" aria-label="Incidentes do backbone">
      {/* Só a vista à mostra faz pedidos. */}
      {view === 'outages' && <OutagesView active={active} tabs={tabs} />}
      {view === 'router' && <RouterFindingsView active={active} tabs={tabs} />}
      {view === 'diary' && <DiaryView active={active} tabs={tabs} />}
    </section>
  );
}

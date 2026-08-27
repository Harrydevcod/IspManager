import './DiscoveryWorkspace.css';

import { useMemo, useState } from 'react';
import {
  Antenna,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Radar,
  ShieldAlert,
  SignalHigh,
  Square,
  UserPlus
} from 'lucide-react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorRetry,
  Field,
  MetricCard,
  MetricGrid,
  Message,
  RowActionsMenu,
  Toggle,
  useToast
} from '../../../components';
import { downloadCsv } from '../../../lib/csv';
import { formatPtDateTime } from '../../../lib/format';
import { compareNumber, sortRows, type SortState } from '../../../lib/listView';
import { ipToInt } from '../../../../shared/ip-range';
import { createDiscoveryApi, type DiscoveryCategory, type DiscoveryRow } from './discovery-api';
import { useDiscovery } from './useDiscovery';
import { AssignIpDialog } from './AssignIpDialog';
import { ReconcilePanel } from './ReconcilePanel';
import { BatchRegisterDialog, candidatesFor } from './BatchRegisterDialog';

export type DiscoveryWorkspaceProps = {
  active: boolean;
  /**
   * Abre o formulário de backbone na aba ao lado, já com o que a rede disse:
   * endereço, MAC, o nome anunciado e o modelo detetado.
   */
  onRegisterBackbone: (prefill: {
    ipAddress: string;
    macAddress: string | null;
    name?: string | null;
    model?: string | null;
  }) => void;
};

type Filter = 'todos' | DiscoveryCategory;

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'todos', label: 'Todos' },
  { id: 'desconhecido', label: 'Desconhecidos' },
  { id: 'registado', label: 'Registados' },
  { id: 'ausente', label: 'Sem resposta' },
  { id: 'reservado', label: 'Reservados' },
  { id: 'duplicado', label: 'Duplicados' }
];

const TONE: Record<DiscoveryCategory, 'danger' | 'success' | 'warn' | 'neutral'> = {
  desconhecido: 'danger',
  registado: 'success',
  ausente: 'warn',
  // Reservado não é avaria: está cortado de propósito e o endereço é dele.
  reservado: 'neutral',
  duplicado: 'danger'
};

const LABEL: Record<DiscoveryCategory, string> = {
  desconhecido: 'Desconhecido',
  registado: 'Registado',
  ausente: 'Sem resposta',
  reservado: 'Reservado',
  duplicado: 'Duplicado'
};

/**
 * Ordenar por estado é ordenar por urgência, não por ordem alfabética: quem
 * está na rede sem registo e os IPs em conflito primeiro, quem está em ordem no
 * fim. Alfabético punha "Desconhecido" e "Duplicado" a alternar sem razão.
 */
const SEVERITY: Record<DiscoveryCategory, number> = {
  desconhecido: 0,
  duplicado: 1,
  ausente: 2,
  reservado: 3,
  registado: 4
};

export type DiscoverySortKey = 'ip' | 'estado';

/** O varrimento chega ordenado por endereço; é essa a vista de partida. */
const DEFAULT_SORT: SortState<DiscoverySortKey> = { key: 'ip', direction: 'asc' };

/**
 * Filtra pelo estado escolhido nos chips e ordena.
 *
 * Empate resolve-se pela ordem de chegada, que é a do endereço (o `sortRows` é
 * estável) — por isso ordenar por estado agrupa os estados sem baralhar os IPs
 * lá dentro.
 */
export function orderDiscoveryRows(
  rows: readonly DiscoveryRow[],
  filter: Filter,
  sort: SortState<DiscoverySortKey>
): DiscoveryRow[] {
  const visible = filter === 'todos' ? rows : rows.filter((row) => row.category === filter);
  return sortRows(visible, sort, {
    ip: (a, b) => compareNumber(ipToInt(a.ip), ipToInt(b.ip)),
    estado: (a, b) => compareNumber(SEVERITY[a.category], SEVERITY[b.category])
  });
}

const api = createDiscoveryApi();

/**
 * De onde veio o MAC. "Router" é sempre o **router de gestão do ISP** — o
 * ISPM nunca se liga ao equipamento de um cliente, mesmo quando esse
 * equipamento é ele próprio um MikroTik e aparece nesta lista.
 */
function sourceLabel(source: string | null): string {
  if (source === 'router') return 'Visto na tabela do router de gestão';
  if (source === 'arp') return 'Visto na tabela ARP desta máquina';
  if (source === 'ping') return 'Respondeu ao ping';
  return 'Origem desconhecida';
}

/**
 * Quanto vale o modelo que está na linha.
 *
 * Dizer só "CPE710" esconde a diferença entre o aparelho ter-se identificado e
 * alguém o ter escrito num formulário há dois anos. Quando as duas coisas
 * discordam é justamente a origem que decide em quem acreditar.
 */
const MODEL_SOURCE_LABEL: Record<string, string> = {
  registo: 'Modelo registado no ISPM',
  snmp: 'O equipamento identificou-se por SNMP',
  router: 'Anunciado ao router de gestão',
  http: 'Lido na interface web do equipamento'
};

/**
 * Que aparelho é: o modelo quando se sabe, o fabricante quando só se sabe isso.
 *
 * Uma coluna e não duas. O fabricante sozinho — tudo o que o OUI do MAC dá — é
 * o degrau abaixo do modelo, não uma informação a par dele; empilhá-los na
 * mesma célula diz a mesma coisa sem roubar largura às outras colunas.
 */
function DeviceCell({ row }: { row: DiscoveryRow }) {
  if (!row.model) {
    return row.vendor
      ? (
        <div className="discovery-device">
          <span>{row.vendor}</span>
          <span className="discovery-device-meta" title="Fabricante deduzido do MAC">fabricante</span>
        </div>
      )
      : <span className="discovery-muted">—</span>;
  }

  const source = row.modelSource ?? 'registo';
  return (
    <div className={row.modelMismatch ? 'discovery-device is-mismatch' : 'discovery-device'}>
      <span className="discovery-model" title={MODEL_SOURCE_LABEL[source]}>{row.model}</span>
      <span
        className="discovery-device-meta"
        title={row.modelMismatch
          ? `O equipamento na rede responde "${row.probedModel}" — provavelmente foi trocado no terreno sem atualizar o registo`
          : MODEL_SOURCE_LABEL[source]}
      >
        {/* Dizer que não bate sem dizer com o quê é metade de um aviso. */}
        {row.modelMismatch ? `rede: ${row.probedModel}` : source}
      </span>
    </div>
  );
}

/** O nome do dono ganha ao que a máquina anuncia — é o que o operador procura. */
function displayName(row: DiscoveryRow): string {
  if (row.registeredAs.length > 0) {
    return row.registeredAs.map((ref) => ref.name).join(' · ');
  }
  return row.hostname ?? '—';
}

export function DiscoveryWorkspace({ active, onRegisterBackbone }: DiscoveryWorkspaceProps) {
  const discovery = useDiscovery(active, api);
  const { report, progress, scanning } = discovery;
  const [filter, setFilter] = useState<Filter>('todos');
  const [sort, setSort] = useState<SortState<DiscoverySortKey>>(DEFAULT_SORT);
  const [assigning, setAssigning] = useState<DiscoveryRow | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const { toast } = useToast();

  const rows = useMemo(
    () => (report ? orderDiscoveryRows(report.rows, filter, sort) : []),
    [report, filter, sort]
  );

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${what} copiado`, 'success');
    } catch {
      toast('Não foi possível copiar', 'error');
    }
  }

  async function openDevice(ip: string) {
    const url = `http://${ip}`;
    const opened = await window.ispm?.openExternal?.(url);
    // Sem Electron (dev no browser) o `window.open` cobre o caso.
    if (opened === undefined) window.open(url, '_blank', 'noopener');
  }

  function exportCsv() {
    if (!report) return;
    downloadCsv('ispm-descoberta-rede.csv', [
      ['IP', 'Estado', 'Nome', 'MAC', 'Fabricante', 'Modelo', 'Origem do modelo', 'Modelo na rede', 'Latencia ms', 'Visto pela primeira vez'],
      ...rows.map((row) => [
        row.ip,
        LABEL[row.category],
        displayName(row),
        row.mac ?? '',
        row.vendor ?? '',
        row.model ?? '',
        row.modelSource ?? '',
        row.probedModel ?? '',
        row.rttMs ?? '',
        row.firstSeenAt ?? ''
      ])
    ]);
  }

  const batchCandidates = useMemo(() => candidatesFor(report?.rows ?? []).length, [report]);

  const counts = report?.counts;
  /** Só há router para consultar depois de o relatório o confirmar. */
  const routerAvailable = report?.routerConfigured ?? false;

  return (
    <section className="discovery-workspace" aria-label="Descoberta de equipamentos na rede">
      <div className="discovery-toolbar">
        <Field
          label="Intervalo"
          className="discovery-range"
          placeholder="192.168.1.1-254"
          value={discovery.range}
          onChange={(event) => discovery.setRange(event.target.value)}
          hint="Aceita 192.168.1.0/24 ou 192.168.1.1-254"
          disabled={scanning}
        />
        {/* Ligado só quando há mesmo router para consultar. Um interruptor a
            verde sem router configurado promete o que a rota nunca faz — ela
            exige `isRouterConfigured` antes de contactar seja o que for. Antes
            do primeiro relatório ainda não se sabe, e não saber mostra-se
            desligado: é preferível a anunciar uma capacidade por confirmar. */}
        <Toggle
          title="Consultar o router de gestão"
          description={
            routerAvailable
              ? 'Junta o ARP e as concessões DHCP do router de gestão do ISP'
              : 'Configure o router em Definições › Rede'
          }
          wide={false}
          checked={discovery.includeRouter && routerAvailable}
          disabled={scanning || !routerAvailable}
          onChange={(event) => discovery.setIncludeRouter(event.target.checked)}
        />
        {/* Desligado por omissão: é o único caminho da aba que sai do ICMP e vai
            bater à porta do equipamento do cliente. Fica ao lado do interruptor
            do router porque a pergunta é a mesma — até onde é que isto vai. */}
        <Toggle
          title="Identificar modelos"
          description="Pergunta a cada equipamento vivo que aparelho é. Demora mais."
          wide={false}
          checked={discovery.identifyModels}
          disabled={scanning}
          onChange={(event) => discovery.setIdentifyModels(event.target.checked)}
        />
        <div className="discovery-toolbar-actions">
          {scanning ? (
            <Button variant="secondary" leadingIcon={<Square size={16} aria-hidden />} onClick={discovery.stop}>
              Parar
            </Button>
          ) : (
            <Button
              leadingIcon={<Radar size={16} aria-hidden />}
              onClick={discovery.scan}
              loading={discovery.loading}
            >
              Varrer
            </Button>
          )}
          {/* Só aparece quando há mesmo lote para registar — um botão que abre
              um diálogo vazio é um convite falhado. */}
          {batchCandidates > 0 ? (
            <Button
              variant="secondary"
              leadingIcon={<Antenna size={16} aria-hidden />}
              onClick={() => setBatchOpen(true)}
              disabled={scanning}
            >
              Registar {batchCandidates}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            leadingIcon={<Download size={16} aria-hidden />}
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            CSV
          </Button>
        </div>
      </div>

      {progress ? (
        <div className="discovery-progress" role="status" aria-live="polite">
          <progress value={progress.done} max={progress.total} />
          <span>
            {progress.done} / {progress.total} {progress.phase === 'identify' ? 'a identificar' : 'endereços'}
          </span>
        </div>
      ) : null}

      <ReconcilePanel data={discovery.reconciliation} api={api} onChanged={discovery.refresh} />

      {discovery.error ? (
        <ErrorRetry message={discovery.error} onRetry={discovery.refresh} />
      ) : null}

      {report && discovery.includeRouter && report.routerConfigured && !report.routerEnriched ? (
        <Message tone="neutral">
          O router de gestão não respondeu — a lista mostra só o que a máquina local conseguiu ver.
        </Message>
      ) : null}

      {counts ? (
        <MetricGrid label="Indicadores da descoberta">
          <MetricCard
            icon={ShieldAlert}
            tone="danger"
            label="Desconhecidos"
            value={String(counts.desconhecido)}
            trend="na rede sem registo no ISPM"
            onActivate={() => setFilter('desconhecido')}
          />
          <MetricCard
            icon={SignalHigh}
            tone="success"
            label="Registados"
            value={String(counts.registado)}
            trend="responderam e têm dono"
            onActivate={() => setFilter('registado')}
          />
          <MetricCard
            icon={Antenna}
            tone="warning"
            label="Sem resposta"
            value={String(counts.ausente + counts.duplicado)}
            trend={counts.duplicado > 0 ? `${counts.duplicado} com IP duplicado` : 'registados que não responderam'}
            onActivate={() => setFilter(counts.duplicado > 0 ? 'duplicado' : 'ausente')}
          />
          {/* Antes do primeiro varrimento não há livres nenhuns a declarar: um
              zero aqui leria-se como "a rede está cheia", que é o oposto do que
              se sabe. O traço diz a verdade — ainda não se perguntou. */}
          <MetricCard
            icon={Globe}
            tone="info"
            label="Endereços livres"
            value={report && report.rangeSize > 0 ? String(counts.livre) : '—'}
            trend={
              !report || report.rangeSize === 0
                ? 'varra o intervalo para contar'
                : report.nextFreeIp
                  ? `próximo: ${report.nextFreeIp}`
                  : 'nada livre neste intervalo'
            }
          />
        </MetricGrid>
      ) : null}

      {report ? (
        <div className="discovery-chips" role="group" aria-label="Filtrar por estado">
          {FILTERS.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              className={filter === item.id ? 'is-active' : undefined}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              {item.id !== 'todos' ? <span className="discovery-chip-count">{counts?.[item.id] ?? 0}</span> : null}
            </Button>
          ))}
        </div>
      ) : null}

      <DataTable<DiscoveryRow, DiscoverySortKey>
        rows={rows}
        rowKey={(row) => row.ip}
        gridTemplateColumns="minmax(130px, 0.8fr) 130px minmax(160px, 1.4fr) minmax(150px, 1fr) minmax(150px, 1.1fr) 90px minmax(140px, 1fr)"
        stickyHeader
        sort={sort}
        onSortChange={setSort}
        columns={[
          { header: 'Endereço', sortKey: 'ip', cell: (row) => <code className="discovery-ip">{row.ip}</code> },
          {
            header: 'Estado',
            sortKey: 'estado',
            cell: (row) => <Badge tone={TONE[row.category]}>{LABEL[row.category]}</Badge>
          },
          { header: 'Nome', cell: (row) => displayName(row) },
          {
            header: 'MAC',
            cell: (row) => row.mac
              ? <code className="discovery-mac" title={sourceLabel(row.source)}>{row.mac}</code>
              : <span className="discovery-muted">—</span>
          },
          { header: 'Equipamento', cell: (row) => <DeviceCell row={row} /> },
          {
            header: 'Latência',
            align: 'end',
            cell: (row) => row.rttMs === null
              ? <span className="discovery-muted">—</span>
              : <span className="discovery-num">{row.rttMs} ms</span>
          },
          {
            header: 'Visto desde',
            cell: (row) => row.firstSeenAt
              ? formatPtDateTime(row.firstSeenAt)
              : <span className="discovery-muted">—</span>
          }
        ]}
        actions={(row) => (
          <RowActionsMenu
            groups={[
              {
                label: 'Equipamento',
                items: [
                  {
                    label: 'Abrir interface web',
                    icon: <ExternalLink size={14} aria-hidden />,
                    onClick: () => void openDevice(row.ip)
                  },
                  {
                    label: 'Registar como backbone',
                    icon: <Antenna size={14} aria-hidden />,
                    // Leva tudo o que a rede já disse: escrever à mão o que
                    // está na linha ao lado é o trabalho que isto evita.
                    onClick: () => onRegisterBackbone({
                      ipAddress: row.ip,
                      macAddress: row.mac,
                      name: row.hostname,
                      model: row.probedModel ?? row.model
                    }),
                    disabled: row.registeredAs.some((ref) => ref.kind === 'backbone'),
                    title: row.registeredAs.some((ref) => ref.kind === 'backbone')
                      ? 'Este endereço já pertence a um backbone'
                      : undefined
                  },
                  {
                    label: 'Atribuir a um serviço',
                    icon: <UserPlus size={14} aria-hidden />,
                    onClick: () => setAssigning(row)
                  }
                ]
              },
              {
                label: 'Copiar',
                items: [
                  { label: 'Copiar IP', icon: <Copy size={14} aria-hidden />, onClick: () => void copy(row.ip, 'IP') },
                  ...(row.mac
                    ? [{ label: 'Copiar MAC', icon: <Copy size={14} aria-hidden />, onClick: () => void copy(row.mac!, 'MAC') }]
                    : [])
                ]
              }
            ]}
          />
        )}
        empty={
          <EmptyState
            icon={Radar}
            title={report ? 'Nada a mostrar neste filtro' : 'A rede ainda não foi varrida'}
            description={
              report
                ? 'Escolha outro estado ou varra um intervalo diferente.'
                : 'Escreva o intervalo de endereços e carregue em Varrer. O ISPM cruza o que encontrar com os equipamentos que já conhece.'
            }
          />
        }
      />

      <BatchRegisterDialog
        open={batchOpen}
        rows={report?.rows ?? []}
        onClose={() => setBatchOpen(false)}
        onRegistered={discovery.refresh}
      />

      {assigning ? (
        <AssignIpDialog
          ip={assigning.ip}
          mac={assigning.mac}
          onClose={() => setAssigning(null)}
          onAssign={async (assignmentId) => {
            await api.assignIp(assignmentId, assigning.ip, assigning.mac);
            setAssigning(null);
            toast(`${assigning.ip} atribuído ao serviço`, 'success');
            discovery.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

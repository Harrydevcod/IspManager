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
import { createDiscoveryApi, type DiscoveryCategory, type DiscoveryRow } from './discovery-api';
import { useDiscovery } from './useDiscovery';
import { AssignIpDialog } from './AssignIpDialog';

export type DiscoveryWorkspaceProps = {
  active: boolean;
  /** Abre o formulário de backbone na aba ao lado, já com o IP e o MAC. */
  onRegisterBackbone: (prefill: { ipAddress: string; macAddress: string | null }) => void;
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
  const [assigning, setAssigning] = useState<DiscoveryRow | null>(null);
  const { toast } = useToast();

  const rows = useMemo(() => {
    if (!report) return [];
    return filter === 'todos' ? report.rows : report.rows.filter((row) => row.category === filter);
  }, [report, filter]);

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
      ['IP', 'Estado', 'Nome', 'MAC', 'Fabricante', 'Latencia ms', 'Visto pela primeira vez'],
      ...rows.map((row) => [
        row.ip,
        LABEL[row.category],
        displayName(row),
        row.mac ?? '',
        row.vendor ?? '',
        row.rttMs ?? '',
        row.firstSeenAt ?? ''
      ])
    ]);
  }

  const counts = report?.counts;

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
        <Toggle
          title="Consultar o router de gestão"
          description={
            report && !report.routerConfigured
              ? 'Sem router de gestão configurado nas definições'
              : 'Junta o ARP e as concessões DHCP do router da operadora'
          }
          wide={false}
          checked={discovery.includeRouter}
          disabled={scanning || (report ? !report.routerConfigured : false)}
          onChange={(event) => discovery.setIncludeRouter(event.target.checked)}
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
          <span>{progress.done} / {progress.total} endereços</span>
        </div>
      ) : null}

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

      <DataTable<DiscoveryRow>
        rows={rows}
        rowKey={(row) => row.ip}
        gridTemplateColumns="minmax(130px, 0.8fr) 130px minmax(160px, 1.4fr) minmax(150px, 1fr) minmax(110px, 0.8fr) 90px minmax(140px, 1fr)"
        stickyHeader
        columns={[
          { header: 'Endereço', cell: (row) => <code className="discovery-ip">{row.ip}</code> },
          { header: 'Estado', cell: (row) => <Badge tone={TONE[row.category]}>{LABEL[row.category]}</Badge> },
          { header: 'Nome', cell: (row) => displayName(row) },
          {
            header: 'MAC',
            cell: (row) => row.mac
              ? <code className="discovery-mac" title={sourceLabel(row.source)}>{row.mac}</code>
              : <span className="discovery-muted">—</span>
          },
          { header: 'Fabricante', cell: (row) => row.vendor ?? <span className="discovery-muted">—</span> },
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
                    onClick: () => onRegisterBackbone({ ipAddress: row.ip, macAddress: row.mac }),
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

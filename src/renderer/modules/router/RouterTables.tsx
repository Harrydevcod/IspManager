import { AlertTriangle, Cable, Layers, ScrollText, ShieldAlert, Unplug, Waypoints, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, DataTable, EmptyState, Toggle, useToast, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { routerSyncBadge } from '../plans/routerSync';
import { formatBytes, logFindings, logTone, SESSION_STATE, type ProfileRow, type RouterLog, type RouterLogEntry, type RouterInterface, type RouterSession } from './router-api';

const SESSION_COLUMNS: DataTableColumn<RouterSession>[] = [
  { header: 'Cliente', sortValue: (row) => row.clientName ?? '', cell: (row) => row.clientName ? <strong>{row.clientName}</strong> : <span className="router-muted">—</span> },
  { header: 'Utilizador PPPoE', sortValue: (row) => row.login, cell: (row) => <code className="router-mono">{row.login}</code> },
  {
    header: 'Estado',
    sortValue: (row) => SESSION_STATE[row.state].rank,
    cell: (row) => <Badge tone={SESSION_STATE[row.state].tone}>{SESSION_STATE[row.state].label}</Badge>
  },
  { header: 'IP', sortValue: (row) => row.address ?? '', cell: (row) => <span className="router-mono">{row.address ?? '—'}</span> },
  { header: 'Ligado há', sortValue: (row) => row.uptime ?? '', cell: (row) => row.uptime ?? '—' },
  {
    header: 'Perfil no router',
    sortValue: (row) => row.routerProfile ?? '',
    cell: (row) => (
      <span className="router-mono">
        {row.routerProfile ?? '—'}
        {row.suspended ? ' · suspenso' : ''}
      </span>
    )
  }
];

export function SessionsTable({ sessions, onChanged }: { sessions: RouterSession[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);

  async function disconnect(row: RouterSession) {
    if (row.serviceId === null) return;
    setBusyId(row.serviceId);
    try {
      const response = await authFetch(`http://127.0.0.1:3001/api/network/services/${row.serviceId}/disconnect`, { method: 'POST' });
      const result = await response.json() as { error?: string; dryRun?: boolean; online?: boolean; disconnected?: boolean };
      if (!response.ok) toast(result.error ?? 'Não foi possível desligar a sessão.', 'error');
      else if (result.dryRun) toast(`Ensaio: a sessão de ${row.login} seria desligada. Nada foi alterado.`, 'info');
      else if (result.disconnected) toast(`Sessão de ${row.login} desligada. O cliente volta a autenticar-se sozinho.`, 'success');
      else toast(`${row.login} já não tinha sessão ativa.`, 'info');
      onChanged();
    } catch {
      toast('Falha de rede ao desligar a sessão.', 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <DataTable
      rows={sessions}
      rowKey={(row) => `${row.serviceId ?? 'x'}-${row.login}`}
      stickyHeader
      defaultSort={{ key: 'Estado', direction: 'asc' }}
      gridTemplateColumns="minmax(160px, 1.3fr) minmax(130px, 1fr) minmax(200px, 1.1fr) minmax(110px, 0.8fr) minmax(90px, 0.7fr) minmax(130px, 1fr)"
      actionsWidth="48px"
      columns={SESSION_COLUMNS}
      actions={(row) => row.online && row.serviceId !== null ? (
        <Button
          variant="icon"
          size="sm"
          className="row-action"
          title="Desligar a sessão (o cliente volta a ligar-se)"
          aria-label={`Desligar a sessão de ${row.login}`}
          loading={busyId === row.serviceId}
          onClick={() => void disconnect(row)}
        >
          <Unplug size={14} aria-hidden />
        </Button>
      ) : null}
      empty={<EmptyState icon={Cable} title="Sem utilizadores PPPoE" description="Nem o ISPM nem o router têm secrets PPPoE." />}
    />
  );
}

const PROFILE_COLUMNS: DataTableColumn<ProfileRow>[] = [
  { header: 'Perfil', sortValue: (row) => row.name, cell: (row) => <code className="router-mono">{row.name}</code> },
  {
    header: 'Velocidade (↑/↓)',
    sortValue: (row) => row.rateLimit ?? '',
    // O RouterOS junta ao par principal o burst e a prioridade; o par é o que se lê, o resto fica na dica.
    cell: (row) => <span className="router-mono" title={row.rateLimit ?? undefined}>{row.rateLimit?.split(' ')[0] ?? '—'}</span>
  },
  {
    header: 'Origem',
    sortValue: (row) => (row.missing ? 2 : row.managedByIspm ? 0 : 1),
    cell: (row) => row.missing
      ? <Badge tone="danger">Falta no router</Badge>
      : row.managedByIspm ? <Badge tone="info">Criado pelo ISPM</Badge> : <Badge tone="neutral">Do operador</Badge>
  },
  {
    header: 'Planos',
    sortValue: (row) => row.plans.length,
    defaultDirection: 'desc',
    cell: (row) => row.plans.length ? row.plans.map((plan) => plan.name).join(', ') : <span className="router-muted">Nenhum</span>
  },
  {
    header: 'Sincronização',
    sortValue: (row) => (row.plans[0] ? routerSyncBadge(row.plans[0]).label : ''),
    cell: (row) => {
      if (!row.plans[0]) return <span className="router-muted">—</span>;
      const badge = routerSyncBadge(row.plans[0]);
      return <span title={badge.title}><Badge tone={badge.tone}>{badge.label}</Badge></span>;
    }
  }
];

export function ProfilesTable({ profiles }: { profiles: ProfileRow[] }) {
  return (
    <DataTable
      rows={profiles}
      rowKey={(row) => row.name}
      stickyHeader
      defaultSort={{ key: 'Planos', direction: 'desc' }}
      gridTemplateColumns="minmax(150px, 1fr) minmax(120px, 0.8fr) minmax(130px, 0.8fr) minmax(160px, 1.4fr) minmax(110px, 0.8fr)"
      columns={PROFILE_COLUMNS}
      empty={<EmptyState icon={Layers} title="Sem perfis PPP" description="O router não devolveu perfis." />}
    />
  );
}

const INTERFACE_COLUMNS: DataTableColumn<RouterInterface>[] = [
  { header: 'Interface', sortValue: (row) => row.name, cell: (row) => <strong className="router-mono">{row.name}</strong> },
  { header: 'Tipo', sortValue: (row) => row.type ?? '', cell: (row) => row.type ?? '—' },
  {
    header: 'Estado',
    sortValue: (row) => (row.disabled ? 2 : row.running ? 0 : 1),
    cell: (row) => row.disabled
      ? <Badge tone="neutral">Desativada</Badge>
      : row.running ? <Badge tone="success">Ligada</Badge> : <Badge tone="danger">Sem ligação</Badge>
  },
  { header: 'MAC', sortValue: (row) => row.macAddress ?? '', cell: (row) => <span className="router-mono">{row.macAddress ?? '—'}</span> },
  { header: 'Recebido', sortValue: (row) => row.rxBytes ?? -1, defaultDirection: 'desc', align: 'end', cell: (row) => <span className="router-number">{formatBytes(row.rxBytes)}</span> },
  { header: 'Enviado', sortValue: (row) => row.txBytes ?? -1, defaultDirection: 'desc', align: 'end', cell: (row) => <span className="router-number">{formatBytes(row.txBytes)}</span> },
  { header: 'Comentário', sortValue: (row) => row.comment ?? '', cell: (row) => row.comment ?? '' }
];

export function InterfacesTable({ interfaces }: { interfaces: RouterInterface[] }) {
  return (
    <DataTable
      rows={interfaces}
      rowKey={(row) => row.name}
      stickyHeader
      defaultSort={{ key: 'Recebido', direction: 'desc' }}
      gridTemplateColumns="minmax(130px, 1fr) minmax(90px, 0.7fr) minmax(110px, 0.8fr) minmax(150px, 1fr) minmax(100px, 0.8fr) minmax(100px, 0.8fr) minmax(140px, 1.2fr)"
      columns={INTERFACE_COLUMNS}
      empty={<EmptyState icon={Waypoints} title="Sem interfaces" description="O router não devolveu interfaces." />}
    />
  );
}

const LOG_COLUMNS: DataTableColumn<RouterLogEntry>[] = [
  // O RouterOS escreve só a hora nas linhas de hoje; a ordem vem do .id (*hex, crescente).
  { header: 'Hora', sortValue: (row) => parseInt(row.id.replace('*', ''), 16) || 0, cell: (row) => <span className="router-mono router-number">{row.time}</span> },
  {
    header: 'Tópicos',
    sortValue: (row) => row.topics,
    cell: (row) => logTone(row.topics) === 'neutral'
      ? <span className="router-mono">{row.topics}</span>
      : <Badge tone={logTone(row.topics)}>{row.topics}</Badge>
  },
  { header: 'Mensagem', sortValue: (row) => row.message, cell: (row) => row.message }
];

export function LogView({ log }: { log: RouterLog }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const findings = logFindings(log);
  const rows = onlyProblems ? log.entries.filter((entry) => logTone(entry.topics) !== 'neutral') : log.entries;
  return (
    <>
      {findings.length > 0 && (
        <section className="router-findings" aria-label="O que o registo diz">
          <h3><ShieldAlert size={16} aria-hidden /> O que o registo diz</h3>
          <ol className="settings-router-steps">
            {findings.map((finding) => (
              <li key={finding.key} data-status={finding.severity === 'grave' ? 'fail' : 'warn'}>
                {finding.severity === 'grave'
                  ? <X size={14} aria-hidden className="settings-router-step-icon" />
                  : <AlertTriangle size={14} aria-hidden className="settings-router-step-icon" />}
                <div>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                </div>
                <span />
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="router-log-filter">
        <Toggle title="Só erros e avisos" wide={false} checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} />
      </div>
      <DataTable
        rows={rows}
        rowKey={(row) => row.id}
        stickyHeader
        defaultSort={{ key: 'Hora', direction: 'desc' }}
        gridTemplateColumns="minmax(150px, 0.6fr) minmax(140px, 0.6fr) minmax(260px, 3fr)"
        columns={LOG_COLUMNS}
        empty={<EmptyState icon={ScrollText} title={onlyProblems ? 'Sem erros nem avisos' : 'Registo vazio'} description="O router não tem linhas no registo em memória." />}
      />
    </>
  );
}

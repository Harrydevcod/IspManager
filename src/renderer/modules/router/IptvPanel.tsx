import { AlertTriangle, Check, ListChecks, Network, ShieldCheck, Tv, X } from 'lucide-react';
import { Badge, DataTable, EmptyState, ErrorRetry, Message, SkeletonList, type DataTableColumn } from '../../components';
import { CHECK_STATUS, describeSource, type IptvActive, type IptvCheck, type IptvProvider, type IptvStatus, type IptvSyncResult, type IptvTarget } from '../iptv/iptv-api';
import { IptvProviders } from './IptvProviders';
import type { ServiceRow } from '../../types';

type Live<T> = { data: T | null; error: string | null; reload: () => void };

const STEP_ICON = { ok: Check, warn: AlertTriangle, fail: X } as const;

/** O que tem de existir no router para o IPTV ir pela VPN. Só o admin a lê; fora da rede diz porquê. */
function Infrastructure({ infra }: { infra: Live<IptvCheck[]> }) {
  return (
    <section className="router-findings" aria-label="Infraestrutura no router">
      <h3><ShieldCheck size={16} aria-hidden /> Infraestrutura no router</h3>
      {infra.error && !infra.data ? <Message tone="neutral">{infra.error}</Message>
        : !infra.data ? <SkeletonList rows={3} />
        : (
          <ol className="settings-router-steps">
            {infra.data.map((check) => {
              const status = CHECK_STATUS[check.state];
              const Icon = STEP_ICON[status.status];
              return (
                <li key={check.key} data-status={status.status}>
                  <Icon size={14} aria-hidden className="settings-router-step-icon" />
                  <div>
                    <strong>{check.label}</strong>
                    {check.detail && <p>{check.detail}</p>}
                  </div>
                  <span>{status.label}</span>
                </li>
              );
            })}
          </ol>
        )}
      <p className="router-muted">
        O túnel, a tabela e a marca descobrem-se a partir da lista de origens. Trocar de VPN ou de WAN faz-se só no router.
      </p>
    </section>
  );
}

type ClientRow = IptvTarget & { clientName: string; active: IptvActive | null };

const ENTRY: Record<'pppoe' | 'legacy', string> = { pppoe: 'PPPoE', legacy: 'Legacy (DHCP)' };

function Clients({ rows, lastRan }: { rows: ClientRow[]; lastRan: boolean }) {
  const columns: DataTableColumn<ClientRow>[] = [
    { header: 'Cliente', cell: (row) => <strong>{row.clientName}</strong>, sortValue: (row) => row.clientName },
    {
      header: 'Origem',
      cell: (row) => {
        const source = describeSource(row.source);
        return source.tone === 'warn' ? <Badge tone="warn">{source.text}</Badge> : source.text;
      }
    },
    {
      header: 'A entrar por',
      cell: (row) => !lastRan ? <span className="router-muted">Sem passagem</span>
        : row.active?.via ? <Badge tone="success">{ENTRY[row.active.via]}</Badge>
        : <Badge tone="neutral">Desligado</Badge>,
      sortValue: (row) => row.active?.via ?? ''
    },
    { header: 'Endereço', cell: (row) => (row.active?.via ? <code>{row.active.address}</code> : <span className="router-muted">—</span>) }
  ];
  return (
    <section className="router-findings" aria-label="Clientes com IPTV via VPN">
      <h3><Tv size={16} aria-hidden /> Clientes com IPTV via VPN</h3>
      <DataTable
        rows={rows}
        rowKey={(row) => row.serviceId}
        columns={columns}
        gridTemplateColumns="minmax(10rem, 1.2fr) minmax(14rem, 2fr) 9rem 9rem"
        empty={<EmptyState size="sm" icon={Tv} title="Nenhum serviço com IPTV via VPN" description="Marque o serviço na ficha dele, em Serviços." />}
      />
    </section>
  );
}

type ManualRow = { key: string; address: string; comment: string | null; kind: string; tone: 'warn' | 'danger' | 'neutral' };

/** As entradas manuais da lista de origens que pedem atenção. O ISPM nunca as apaga. */
function ManualEntries({ last }: { last: Extract<IptvSyncResult, { status: 'applied' | 'dry_run' }> }) {
  const rows: ManualRow[] = [
    ...last.foreignManual.map((e) => ({ key: `f-${e.address}`, address: e.address, comment: e.comment, kind: `De outro cliente (${e.holder})`, tone: 'danger' as const })),
    ...last.unownedManual.map((e) => ({ key: `u-${e.address}`, address: e.address, comment: e.comment, kind: 'Obsoleta: ninguém tem este IP', tone: 'warn' as const })),
    ...last.manualConflicts.map((e) => ({ key: `c-${e.address}`, address: e.address, comment: e.comment, kind: 'Em uso por um cliente marcado', tone: 'neutral' as const }))
  ];
  if (rows.length === 0) return null;
  const columns: DataTableColumn<ManualRow>[] = [
    { header: 'Endereço', cell: (row) => <code>{row.address}</code> },
    { header: 'Comentário', cell: (row) => row.comment || <span className="router-muted">—</span> },
    { header: 'Situação', cell: (row) => <Badge tone={row.tone}>{row.kind}</Badge> }
  ];
  return (
    <section className="router-findings" aria-label="Entradas manuais na lista de origens">
      <h3><ListChecks size={16} aria-hidden /> Entradas manuais na lista de origens</h3>
      <p className="router-muted">Foram postas à mão no router. O ISPM nunca as apaga: reveja-as e remova as que já não servem.</p>
      <DataTable rows={rows} rowKey={(row) => row.key} columns={columns} gridTemplateColumns="9rem minmax(10rem, 1.5fr) minmax(12rem, 1.5fr)" empty={null} />
    </section>
  );
}

const diff = (before: string[], after: string[]) => ({
  added: after.filter((value) => !before.includes(value)),
  removed: before.filter((value) => !after.includes(value))
});

/** A última passagem do router: aplicou, ensaiou (e o que mudaria) ou falhou. */
function LastPass({ last }: { last: IptvSyncResult | null }) {
  if (!last) return <Message tone="neutral">O router ainda não fez nenhuma passagem com o IPTV.</Message>;
  if ('error' in last) return <Message tone="error">A última passagem falhou: {last.error}</Message>;
  if (last.status === 'idle') return null;
  const users = diff(last.before?.users ?? [], last.users);
  const macs = diff(last.before?.macs ?? [], last.macs);
  const changes = [
    ...users.added.map((v) => `+ PPPoE ${v}`), ...users.removed.map((v) => `− PPPoE ${v}`),
    ...macs.added.map((v) => `+ MAC ${v}`), ...macs.removed.map((v) => `− MAC ${v}`)
  ];
  const { added, removed, renamed, reactivated } = last.servers;
  const servers = [added && `${added} servidor(es) a acrescentar`, removed && `${removed} a retirar`, renamed && `${renamed} a renomear`, reactivated && `${reactivated} a reativar`].filter(Boolean);
  return (
    <section className="router-findings" aria-label="Última passagem">
      <h3><Network size={16} aria-hidden /> Última passagem</h3>
      <p>
        {last.status === 'dry_run'
          ? <Badge tone="info">Em ensaio: nada foi escrito</Badge>
          : <Badge tone="success">Aplicada</Badge>}
        {' '}{last.users.length} PPPoE · {last.macs.length} MAC legacy no script
      </p>
      {(changes.length > 0 || servers.length > 0) && (
        <ul className="iptv-diff">
          {changes.map((line) => <li key={line}><code>{line}</code></li>)}
          {servers.map((line) => <li key={String(line)}>{line}</li>)}
        </ul>
      )}
    </section>
  );
}

export function IptvPanel({ status, infra, providers, services, isAdmin }: {
  status: Live<IptvStatus>;
  infra: Live<IptvCheck[]> | null;
  providers: Live<IptvProvider[]>;
  services: ServiceRow[];
  isAdmin: boolean;
}) {
  if (status.error && !status.data) return <ErrorRetry message={status.error} onRetry={status.reload} />;
  if (!status.data) return <SkeletonList rows={5} />;
  const { targets, last } = status.data;
  const ran = last && 'status' in last && last.status !== 'idle' ? last : null;
  const names = new Map(services.map((s) => [s.id, s.clientName]));
  const rows: ClientRow[] = targets.map((t) => ({
    ...t,
    clientName: names.get(t.serviceId) ?? `Serviço ${t.serviceId}`,
    active: ran?.active.find((a) => a.serviceId === t.serviceId) ?? null
  }));

  return (
    <div className="iptv-panel">
      {infra && <Infrastructure infra={infra} />}
      <LastPass last={last} />
      <Clients rows={rows} lastRan={Boolean(ran)} />
      {ran && <ManualEntries last={ran} />}
      <IptvProviders providers={providers.data ?? []} canEdit={isAdmin} onChanged={() => { providers.reload(); status.reload(); }} />
    </div>
  );
}

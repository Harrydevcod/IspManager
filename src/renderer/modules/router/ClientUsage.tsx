import { useMemo, useState } from 'react';
import { Button, DataTable, EmptyState, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { FupUsageBar } from '../fup/FupUsageSection';
import { formatGb, type FupThresholds, type FupUsage } from '../fup/fup-api';
import { formatDataVolume, ROUTER_API } from './router-api';

export type ClientUsageRow = {
  serviceId: number;
  clientCode: string;
  clientName: string;
  plan: string;
  todayDownBytes: number;
  todayUpBytes: number;
  monthDownBytes: number;
  monthUpBytes: number;
  measured: number;
};

export type ClientUsageFup = { usage: FupUsage[]; thresholds: FupThresholds };

const volume = (row: ClientUsageRow, bytes: number) => row.measured ? formatDataVolume(bytes) : 'Sem medição';

const baseColumns: DataTableColumn<ClientUsageRow>[] = [
  { header: 'Código', sortValue: (row) => row.clientCode, cell: (row) => row.clientCode },
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
  { header: 'Plano', sortValue: (row) => row.plan, cell: (row) => row.plan },
  { header: 'Hoje', sortValue: (row) => row.todayDownBytes + row.todayUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.todayDownBytes + row.todayUpBytes) },
  { header: 'Mês ↓', sortValue: (row) => row.monthDownBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthDownBytes) },
  { header: 'Mês ↑', sortValue: (row) => row.monthUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthUpBytes) },
  { header: 'Total do mês', sortValue: (row) => row.monthDownBytes + row.monthUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthDownBytes + row.monthUpBytes) }
];

// Ciclo FUP (não o mês civil das colunas ao lado): a mesma barra dos Clientes e da ficha.
function fupColumn(byService: Map<number, FupUsage>, thresholds: FupThresholds | null): DataTableColumn<ClientUsageRow> {
  return {
    header: 'Uso justo',
    defaultDirection: 'desc',
    sortValue: (row) => {
      const fup = byService.get(row.serviceId);
      // Sem referência fica abaixo de qualquer % (bytes em TB, < 1) e acima de "sem dados".
      return fup ? (fup.referenceGb > 0 ? fup.percent : fup.totalBytes / 1e12) : -1;
    },
    cell: (row) => {
      const fup = byService.get(row.serviceId);
      if (!fup || !thresholds) return <span>—</span>;
      if (fup.referenceGb <= 0) return <span title="Plano sem consumo de referência">{formatGb(fup.totalBytes)}</span>;
      const limited = fup.state === 'LIMITADO';
      return (
        <span className="fup-cell" title={`${formatGb(fup.totalBytes)} de ${fup.referenceGb} GB no ciclo${limited ? ' · limitado no pico' : ''}`}>
          {/* "Limitado" vai no rótulo da barra: um .sr-only absoluto escapa ao scroll da tabela e alarga a página. */}
          <FupUsageBar percent={fup.percent} thresholds={thresholds} label={`Uso justo de ${row.clientName}${limited ? ', limitado no pico' : ''}`} />
          <span>{Math.round(fup.percent)}%</span>
        </span>
      );
    }
  };
}

export function ClientUsage({ rows, fup, onInstalled }: { rows: ClientUsageRow[]; fup: ClientUsageFup | null; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const columns = useMemo(() => {
    const byService = new Map((fup?.usage ?? []).map((usage) => [usage.serviceId, usage]));
    return [...baseColumns, fupColumn(byService, fup?.thresholds ?? null)];
  }, [fup]);
  const install = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await authFetch(`${ROUTER_API}/clients/usage/counter`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? 'Não foi possível instalar o contador.');
      }
      onInstalled();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Não foi possível instalar o contador.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {/* Sem ninguém medido, o contador ainda não está no router (ou ninguém discou PPPoE). */}
      {!rows.some((row) => row.measured) && (
        <div className="router-usage-actions">
          <Button variant="secondary" onClick={install} disabled={busy}>{busy ? 'A instalar…' : 'Contar no router'}</Button>
          <span className="router-muted">Só é medido quem liga por PPPoE · ↓+↑ por dia UTC</span>
        </div>
      )}
      {actionError && <p role="alert" className="router-muted">{actionError}</p>}
      <DataTable rows={rows} rowKey={(row) => row.serviceId} columns={columns}
        // Cabe em 868 px (1225 de ecrã): a barra tem a largura da coluna Consumo dos Clientes.
        gridTemplateColumns="72px minmax(106px, 1.5fr) minmax(100px, 1fr) minmax(76px, .8fr) repeat(2, minmax(82px, .8fr)) minmax(108px, .8fr) 96px"
        defaultSort={{ key: 'Total do mês', direction: 'desc' }}
        empty={<EmptyState title="Sem serviços PPPoE ativos" />} />
    </>
  );
}

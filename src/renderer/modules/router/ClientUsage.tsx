import { useMemo, useState } from 'react';
import { Button, DataTable, EmptyState, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
import { FupUsageBar } from '../fup/FupUsageSection';
import { formatGb, gbLabel, perGbOf, type FupThresholds, type FupUsage } from '../fup/fup-api';
import { formatBytes, formatDataVolume, ROUTER_API } from './router-api';

export type ClientUsageRow = {
  serviceId: number;
  clientCode: string;
  clientName: string;
  plan: string;
  todayDownBytes: number;
  todayUpBytes: number;
  /** Início do ciclo do uso justo (AAAA-MM-DD): o total conta daqui, não do dia 1. */
  cycleStart: string;
  cycleDownBytes: number;
  cycleUpBytes: number;
  measured: number;
};

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

export type ClientUsageFup = { usage: FupUsage[]; thresholds: FupThresholds };

// A unidade das Definições do uso justo: decimal (GB) ou binária (GiB), igual à barra ao lado.
function baseColumns(perGb: number): DataTableColumn<ClientUsageRow>[] {
  const format = perGb === 1024 ** 3 ? formatBytes : formatDataVolume;
  const volume = (row: ClientUsageRow, bytes: number) => row.measured ? format(bytes) : 'Sem medição';
  return [
    { header: 'Código', sortValue: (row) => row.clientCode, cell: (row) => row.clientCode },
    { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
    { header: 'Plano', sortValue: (row) => row.plan, cell: (row) => row.plan },
    { header: 'Hoje', sortValue: (row) => row.todayDownBytes + row.todayUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.todayDownBytes + row.todayUpBytes) },
    { header: 'Ciclo ↓', sortValue: (row) => row.cycleDownBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.cycleDownBytes) },
    { header: 'Ciclo ↑', sortValue: (row) => row.cycleUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.cycleUpBytes) },
    {
      header: 'Total do ciclo', sortValue: (row) => row.cycleDownBytes + row.cycleUpBytes, defaultDirection: 'desc', align: 'end',
      cell: (row) => <span title={`desde ${dmy(row.cycleStart)}`}>{volume(row, row.cycleDownBytes + row.cycleUpBytes)}</span>
    }
  ];
}

// O mesmo ciclo e as mesmas unidades das colunas ao lado: a mesma barra dos Clientes e da ficha.
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
      const perGb = perGbOf(thresholds);
      if (fup.referenceGb <= 0) return <span title="Plano sem consumo de referência">{formatGb(fup.totalBytes, perGb)}</span>;
      const limited = fup.state === 'LIMITADO';
      return (
        <span className="fup-cell" title={`${formatGb(fup.totalBytes, perGb)} de ${fup.referenceGb} ${gbLabel(perGb)} no ciclo${limited ? ' · limitado no pico' : ''}`}>
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
    return [...baseColumns(perGbOf(fup?.thresholds)), fupColumn(byService, fup?.thresholds ?? null)];
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
        defaultSort={{ key: 'Total do ciclo', direction: 'desc' }}
        empty={<EmptyState title="Sem serviços PPPoE ativos" />} />
    </>
  );
}

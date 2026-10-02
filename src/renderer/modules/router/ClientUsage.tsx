import { useState } from 'react';
import { Button, DataTable, EmptyState, type DataTableColumn } from '../../components';
import { authFetch } from '../../lib/auth';
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

const volume = (row: ClientUsageRow, bytes: number) => row.measured ? formatDataVolume(bytes) : 'Sem medição';

const columns: DataTableColumn<ClientUsageRow>[] = [
  { header: 'Código', sortValue: (row) => row.clientCode, cell: (row) => row.clientCode },
  { header: 'Cliente', sortValue: (row) => row.clientName, cell: (row) => <strong>{row.clientName}</strong> },
  { header: 'Plano', sortValue: (row) => row.plan, cell: (row) => row.plan },
  { header: 'Hoje', sortValue: (row) => row.todayDownBytes + row.todayUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.todayDownBytes + row.todayUpBytes) },
  { header: 'Mês ↓', sortValue: (row) => row.monthDownBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthDownBytes) },
  { header: 'Mês ↑', sortValue: (row) => row.monthUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthUpBytes) },
  { header: 'Total do mês', sortValue: (row) => row.monthDownBytes + row.monthUpBytes, defaultDirection: 'desc', align: 'end', cell: (row) => volume(row, row.monthDownBytes + row.monthUpBytes) }
];

export function ClientUsage({ rows, onInstalled }: { rows: ClientUsageRow[]; onInstalled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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
        gridTemplateColumns="82px minmax(150px, 1.5fr) minmax(100px, 1fr) repeat(4, minmax(95px, .8fr))"
        defaultSort={{ key: 'Total do mês', direction: 'desc' }}
        empty={<EmptyState title="Sem serviços PPPoE ativos" description="O consumo aparece aqui quando houver serviços ativos com utilizador PPPoE." />} />
    </>
  );
}

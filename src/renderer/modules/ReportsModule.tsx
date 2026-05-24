import { Activity, Banknote, Cable, MessageCircle, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Field, FilterBar, Message } from '../components';
import { authFetch } from '../lib/auth';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { ReportsSummary, ReportView } from '../types';

type MessagingSettings = { companyName: string; whatsappTemplate: string };

const PAGE_SIZE = 20;

export function ReportsModule() {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  const [view, setView] = useState<ReportView>('revenue');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<string | null>(null);
  const [messagingSettings, setMessagingSettings] = useState<MessagingSettings>({
    companyName: 'ISPM',
    whatsappTemplate: fallbackWhatsappTemplate
  });

  useEffect(() => {
    const params = new URLSearchParams({
      view,
      page: String(page),
      pageSize: String(PAGE_SIZE)
    });
    if (view !== 'stock') {
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
    }

    authFetch(`http://127.0.0.1:3001/api/reports/summary?${params.toString()}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar relatorios');
        }
        return response.json() as Promise<ReportsSummary>;
      })
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Erro ao carregar relatorios');
      });
  }, [view, dateFrom, dateTo, page]);

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/settings')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar configuracoes');
        }
        return response.json() as Promise<MessagingSettings>;
      })
      .then((settings) => {
        setMessagingSettings({
          companyName: settings.companyName || 'ISPM',
          whatsappTemplate: settings.whatsappTemplate || fallbackWhatsappTemplate
        });
      })
      .catch(() => {
        setMessagingSettings({
          companyName: 'ISPM',
          whatsappTemplate: fallbackWhatsappTemplate
        });
      });
  }, []);

  const metrics = summary?.metrics;
  const pagination = summary?.pagination;
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const showingTo = Math.min(page * PAGE_SIZE, total);

  function changeView(nextView: ReportView) {
    setView(nextView);
    setPage(1);
  }

  function csvValue(value: string | number | null) {
    const text = String(value ?? '').replace(/"/g, '""');
    return `"${text}"`;
  }

  function exportCsv() {
    if (!summary) {
      return;
    }

    const rows = view === 'revenue'
      ? [
        ['Mes', 'Pago CVE', 'Pendente CVE', 'Cobrancas'],
        ...summary.revenueByMonth.map((row) => [row.referenceMonth, row.paidCve, row.pendingCve, row.payments])
      ]
      : view === 'overdue'
        ? [
          ['Cliente', 'Codigo', 'Telefone', 'Cobrancas', 'Valor CVE', 'Vencimento mais antigo'],
          ...summary.overdueClients.map((row) => [row.clientName, row.clientCode, row.phone || '', row.payments, row.amountCve, row.oldestDueDate])
        ]
        : [
          ['Tipo', 'Marca', 'Modelo', 'Stock', 'Valor CVE'],
          ...summary.stockRows.map((row) => [row.type, row.brand, row.model, row.stockTotal, row.valueCve])
        ];

    const csv = rows.map((row) => row.map(csvValue).join(';')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ispm-relatorio-${view}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function sendOverdueWhatsapp(row: ReportsSummary['overdueClients'][number]) {
    const message = renderWhatsappMessage(
      messagingSettings.whatsappTemplate,
      {
        fullName: row.clientName,
        clientCode: row.clientCode,
        phone: row.phone
      },
      messagingSettings.companyName
    );
    try {
      await sendWhatsappViaUltraMsg(row.phone, message);
      setError(null);
      setWhatsappStatus('Mensagem WhatsApp enviada via UltraMsg.');
    } catch (err) {
      setWhatsappStatus(null);
      setError(err instanceof Error ? err.message : 'Nao foi possivel enviar WhatsApp');
    }
  }

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Modulo</p>
          <h2>Relatorios</h2>
        </div>
        <div className="inline-actions report-tabs">
          <Button variant="ghost" size="sm" className={view === 'revenue' ? 'active' : ''} onClick={() => changeView('revenue')}>Receita</Button>
          <Button variant="ghost" size="sm" className={view === 'overdue' ? 'active' : ''} onClick={() => changeView('overdue')}>Atrasos</Button>
          <Button variant="ghost" size="sm" className={view === 'stock' ? 'active' : ''} onClick={() => changeView('stock')}>Stock</Button>
          <Button variant="secondary" size="sm" disabled={!summary} onClick={exportCsv}>
            Exportar CSV
          </Button>
        </div>
      </div>

      <FilterBar className="reports-filter-bar">
        <Field
          label="De"
          type="date"
          value={dateFrom}
          disabled={view === 'stock'}
          onChange={(event) => { setDateFrom(event.target.value); setPage(1); }}
        />
        <Field
          label="Ate"
          type="date"
          value={dateTo}
          disabled={view === 'stock'}
          onChange={(event) => { setDateTo(event.target.value); setPage(1); }}
        />
        <Button variant="secondary" disabled={view === 'stock' && !dateFrom && !dateTo} onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}>
          Limpar datas
        </Button>
        <small>
          {view === 'stock' ? `${showingFrom}-${showingTo} de ${total} itens` : `${showingFrom}-${showingTo} de ${total} registos`}
        </small>
      </FilterBar>

      {error && <Message tone="error">{error}</Message>}
      {whatsappStatus && <Message>{whatsappStatus}</Message>}

      <section className="metric-grid compact" aria-label="Resumo de relatorios">
        <article className="metric-card">
          <UsersRound size={20} />
          <span>Clientes</span>
          <strong>{metrics ? metrics.totalClients : '...'}</strong>
          <small>cadastros na base</small>
        </article>
        <article className="metric-card">
          <Cable size={20} />
          <span>Servicos ativos</span>
          <strong>{metrics ? metrics.activeServices : '...'}</strong>
          <small>contratos em operacao</small>
        </article>
        <article className="metric-card">
          <Banknote size={20} />
          <span>Receita paga</span>
          <strong>{metrics ? metrics.paidAmountCve.toLocaleString('pt-PT') : '...'}</strong>
          <small>CVE recebidos</small>
        </article>
        <article className="metric-card">
          <Activity size={20} />
          <span>Em atraso</span>
          <strong>{metrics ? metrics.overdueAmountCve.toLocaleString('pt-PT') : '...'}</strong>
          <small>{metrics ? `${metrics.overduePayments} cobrancas` : 'a carregar'}</small>
        </article>
      </section>

      <div className="module-table">
        {view === 'revenue' && summary?.revenueByMonth.map((row) => (
          <div className="module-row report-row" key={row.referenceMonth}>
            <span>
              <strong>{row.referenceMonth}</strong>
              <small>{row.payments} cobrancas</small>
            </span>
            <small>Pago: {row.paidCve.toLocaleString('pt-PT')} CVE</small>
            <small>Pendente: {row.pendingCve.toLocaleString('pt-PT')} CVE</small>
          </div>
        ))}
        {view === 'overdue' && summary?.overdueClients.map((row) => (
          <div className="module-row report-row with-action" key={row.clientCode}>
            <span>
              <small className="entity-code">{row.clientCode}</small>
              <strong>{row.clientName}</strong>
              <small>{row.phone || 'sem telefone'}</small>
            </span>
            <small>{row.payments} cobrancas</small>
            <small>{row.amountCve.toLocaleString('pt-PT')} CVE</small>
            <Button
              variant="ghost"
              size="sm"
              disabled={!normalizeWhatsappPhone(row.phone)}
              leadingIcon={<MessageCircle size={16} />}
              onClick={() => void sendOverdueWhatsapp(row)}
            >
              WhatsApp
            </Button>
          </div>
        ))}
        {view === 'stock' && summary?.stockRows.map((row) => (
          <div className="module-row report-row" key={`${row.type}-${row.brand}-${row.model}`}>
            <span>
              <strong>{row.brand ? `${row.brand} ${row.model}` : row.model}</strong>
              <small>{row.type}</small>
            </span>
            <small>{row.stockTotal} un.</small>
            <small>{row.valueCve.toLocaleString('pt-PT')} CVE</small>
          </div>
        ))}
        {summary && view === 'revenue' && summary.revenueByMonth.length === 0 && (
          <Message>Ainda nao existem pagamentos para reportar.</Message>
        )}
        {summary && view === 'overdue' && summary.overdueClients.length === 0 && (
          <Message>Nao existem clientes em atraso.</Message>
        )}
        {summary && view === 'stock' && summary.stockRows.length === 0 && (
          <Message>Ainda nao existem equipamentos cadastrados.</Message>
        )}
        {summary && total > PAGE_SIZE && (
          <div className="audit-pagination reports-pagination" aria-label="Paginacao dos relatorios">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Anterior
            </Button>
            <span>Pagina {page} de {totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >
              Proxima
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

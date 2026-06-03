import { Activity, AlertTriangle, Banknote, Cable, CheckCircle2, CopyX, MessageCircle, UserCog, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, EmptyState, Field, FilterBar, Message, MetricCard } from '../components';
import { authFetch } from '../lib/auth';
import { formatCve } from '../lib/format';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { DataQualityIncompleteFlag, DataQualitySummary, ReportsSummary, ReportView } from '../types';

type MessagingSettings = { companyName: string; whatsappTemplate: string };

const PAGE_SIZE = 20;

export function ReportsModule({ onOpenClient }: { onOpenClient?: (clientId: number) => void } = {}) {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  type Tab = ReportView | 'incomplete' | 'duplicates';
  const [view, setView] = useState<Tab>('revenue');
  const [dq, setDq] = useState<DataQualitySummary | null>(null);
  const [issue, setIssue] = useState<DataQualityIncompleteFlag | null>(null);
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
    if (view === 'incomplete' || view === 'duplicates') return;
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
    if (view !== 'incomplete' && view !== 'duplicates') return;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (view === 'incomplete' && issue) params.set('issue', issue);

    authFetch(`http://127.0.0.1:3001/api/reports/data-quality?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error('Nao foi possivel carregar qualidade de dados');
        return response.json() as Promise<DataQualitySummary>;
      })
      .then((data) => { setDq(data); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erro ao carregar qualidade de dados'));
  }, [view, issue, page]);

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

  function changeView(nextView: Tab) {
    setView(nextView);
    setPage(1);
    if (nextView !== 'incomplete') setIssue(null);
  }

  function csvValue(value: string | number | null) {
    const raw = String(value ?? '');
    // Neutralize spreadsheet formula injection (CWE-1236): a cell that opens with
    // =, +, -, @, tab or CR is treated as a formula by Excel/Sheets. Prefix with a
    // single quote so it renders as literal text.
    const text = (/^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw).replace(/"/g, '""');
    return `"${text}"`;
  }

  function exportCsv() {
    if ((view === 'incomplete' || view === 'duplicates') ? !dq : !summary) {
      return;
    }

    let rows: Array<Array<string | number>>;
    if (view === 'revenue') {
      rows = [
        ['Mes', 'Pago CVE', 'Pendente CVE', 'Cobrancas'],
        ...summary!.revenueByMonth.map((row) => [row.referenceMonth, row.paidCve, row.pendingCve, row.payments])
      ];
    } else if (view === 'overdue') {
      rows = [
        ['Cliente', 'Codigo', 'Telefone', 'Cobrancas', 'Valor CVE', 'Vencimento mais antigo'],
        ...summary!.overdueClients.map((row) => [row.clientName, row.clientCode, row.phone || '', row.payments, row.amountCve, row.oldestDueDate])
      ];
    } else if (view === 'stock') {
      rows = [
        ['Tipo', 'Marca', 'Modelo', 'Stock', 'Valor CVE'],
        ...summary!.stockRows.map((row) => [row.type, row.brand, row.model, row.stockTotal, row.valueCve])
      ];
    } else if (view === 'incomplete') {
      rows = [
        ['Codigo', 'Cliente', 'Estado', 'Telefone', 'Lacunas'],
        ...(dq?.incompleteClients ?? []).map((row) => [row.clientCode, row.fullName, row.status, row.phone || '', row.flags.join(' | ')])
      ];
    } else {
      rows = [
        ['Razao', 'Codigo', 'Cliente', 'Telefone'],
        ...(dq?.duplicateGroups ?? []).flatMap((g) => g.clients.map((c) => [g.reason, c.clientCode, c.fullName, c.phone || '']))
      ];
    }

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

  async function dismissDuplicate(clientIdA: number, clientIdB: number) {
    try {
      const response = await authFetch('http://127.0.0.1:3001/api/reports/data-quality/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientIdA, clientIdB })
      });
      if (!response.ok) throw new Error('Nao foi possivel dispensar o par');
      setDq(null);
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      const refetch = await authFetch(`http://127.0.0.1:3001/api/reports/data-quality?${params.toString()}`);
      if (refetch.ok) setDq(await refetch.json() as DataQualitySummary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao dispensar duplicado');
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
          <Button variant="ghost" size="sm" className={view === 'incomplete' ? 'active' : ''} onClick={() => changeView('incomplete')}>Incompletos</Button>
          <Button variant="ghost" size="sm" className={view === 'duplicates' ? 'active' : ''} onClick={() => changeView('duplicates')}>Duplicados</Button>
          <Button variant="secondary" size="sm" disabled={!summary && !dq} onClick={exportCsv}>
            Exportar CSV
          </Button>
        </div>
      </div>

      {view !== 'incomplete' && view !== 'duplicates' && (
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
      )}

      {error && <Message tone="error">{error}</Message>}
      {whatsappStatus && <Message>{whatsappStatus}</Message>}

      {(view === 'incomplete' || view === 'duplicates') ? (
        <section className="metric-grid compact" aria-label="Resumo de qualidade de dados">
          <MetricCard icon={UsersRound} label="Incompletos" value={dq ? String(dq.incompleteCounts.total) : '...'} trend="com pelo menos uma lacuna" />
          <MetricCard icon={MessageCircle} label="Sem telefone" value={dq ? String(dq.incompleteCounts.noPhone) : '...'} trend="sem contacto WhatsApp" />
          <MetricCard icon={Cable} label="Sem servico ativo" value={dq ? String(dq.incompleteCounts.noActiveService) : '...'} trend="nao geram mensalidade" />
          <MetricCard icon={CopyX} label="Grupos duplicados" value={dq ? String(dq.duplicateGroups.length) : '...'} trend="telefone ou nome repetido" />
        </section>
      ) : (
        <section className="metric-grid compact" aria-label="Resumo de relatorios">
          <MetricCard icon={UsersRound} label="Clientes" value={metrics ? String(metrics.totalClients) : '...'} trend="cadastros na base" />
          <MetricCard icon={Cable} label="Servicos ativos" value={metrics ? String(metrics.activeServices) : '...'} trend="contratos em operacao" />
          <MetricCard icon={Banknote} label="Receita paga" value={metrics ? formatCve(metrics.paidAmountCve) : '...'} trend="recebidos" />
          <MetricCard icon={Activity} label="Em atraso" value={metrics ? formatCve(metrics.overdueAmountCve) : '...'} trend={metrics ? `${metrics.overduePayments} cobrancas` : 'a carregar'} />
        </section>
      )}

      <div className="module-table">
        {view === 'revenue' && summary?.revenueByMonth.map((row) => (
          <div className="module-row report-row" key={row.referenceMonth}>
            <span>
              <strong>{row.referenceMonth}</strong>
              <small>{row.payments} cobrancas</small>
            </span>
            <small>Pago: {formatCve(row.paidCve)}</small>
            <small>Pendente: {formatCve(row.pendingCve)}</small>
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
            <small>{formatCve(row.amountCve)}</small>
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
            <small>{formatCve(row.valueCve)}</small>
          </div>
        ))}
        {view === 'incomplete' && (
          <div className="inline-actions dq-issue-filter">
            <Button variant="ghost" size="sm" className={issue === null ? 'active' : ''} onClick={() => { setIssue(null); setPage(1); }}>Todos {dq ? `(${dq.incompleteCounts.total})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noPhone' ? 'active' : ''} onClick={() => { setIssue('noPhone'); setPage(1); }}>Sem telefone {dq ? `(${dq.incompleteCounts.noPhone})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noActiveService' ? 'active' : ''} onClick={() => { setIssue('noActiveService'); setPage(1); }}>Sem servico {dq ? `(${dq.incompleteCounts.noActiveService})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noAddress' ? 'active' : ''} onClick={() => { setIssue('noAddress'); setPage(1); }}>Sem morada {dq ? `(${dq.incompleteCounts.noAddress})` : ''}</Button>
            <Button variant="ghost" size="sm" className={issue === 'noNif' ? 'active' : ''} onClick={() => { setIssue('noNif'); setPage(1); }}>Sem NIF {dq ? `(${dq.incompleteCounts.noNif})` : ''}</Button>
          </div>
        )}
        {view === 'incomplete' && dq?.incompleteClients.map((row) => (
          <button type="button" className="module-row report-row with-action dq-row" key={row.id} onClick={() => onOpenClient?.(row.id)}>
            <span>
              <small className="entity-code">{row.clientCode}</small>
              <strong>{row.fullName}</strong>
              <small>{row.phone || 'sem telefone'}</small>
            </span>
            <span className="dq-flags">
              {row.flags.map((flag) => (
                <span className="badge badge-warn" key={flag}>
                  {flag === 'noPhone' ? 'telefone' : flag === 'noActiveService' ? 'servico' : flag === 'noAddress' ? 'morada' : 'NIF'}
                </span>
              ))}
            </span>
            <UserCog size={16} aria-hidden />
          </button>
        ))}
        {view === 'duplicates' && dq?.duplicateGroups.map((group) => (
          <div className="module-row report-row dq-group" key={group.key}>
            <span className="dq-group-reason">
              <AlertTriangle size={16} aria-hidden />
              <small>{group.reason === 'phone' ? 'Telefone igual' : 'Nome parecido'}</small>
            </span>
            <span className="dq-group-clients">
              {group.clients.map((c) => (
                <Button key={c.id} variant="ghost" size="sm" onClick={() => onOpenClient?.(c.id)}>
                  {c.clientCode} · {c.fullName}
                </Button>
              ))}
            </span>
            {group.clients.length === 2 && (
              <Button variant="ghost" size="sm" leadingIcon={<CopyX size={16} />} onClick={() => void dismissDuplicate(group.clients[0].id, group.clients[1].id)}>
                Nao e duplicado
              </Button>
            )}
          </div>
        ))}
        {view === 'incomplete' && dq && dq.incompleteClients.length === 0 && (
          <EmptyState icon={CheckCircle2} title="Sem dados incompletos" description="Todos os clientes têm os campos essenciais preenchidos." />
        )}
        {view === 'duplicates' && dq && dq.duplicateGroups.length === 0 && (
          <EmptyState icon={CheckCircle2} title="Sem duplicados" description="Não foram encontrados clientes com telefone ou nome repetidos." />
        )}
        {summary && view === 'revenue' && summary.revenueByMonth.length === 0 && (
          <EmptyState
            icon={Banknote}
            title="Ainda sem receita"
            description="Quando emitires e receberes pagamentos, aparecem aqui agrupados por mês."
          />
        )}
        {summary && view === 'overdue' && summary.overdueClients.length === 0 && (
          <EmptyState
            icon={CheckCircle2}
            title="Sem clientes em atraso"
            description="Todas as cobranças estão em dia. Continua assim."
          />
        )}
        {summary && view === 'stock' && summary.stockRows.length === 0 && (
          <EmptyState
            icon={Cable}
            title="Ainda sem equipamentos"
            description="Quando cadastrares equipamentos no Stock, aparecem aqui resumidos por tipo."
          />
        )}
        {((view === 'incomplete' && dq) || (view !== 'incomplete' && view !== 'duplicates' && summary)) && (view === 'incomplete' ? (dq!.pagination.total) : total) > PAGE_SIZE && (
          <div className="audit-pagination reports-pagination" aria-label="Paginacao dos relatorios">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Anterior
            </Button>
            <span>Pagina {page} de {view === 'incomplete' ? dq!.pagination.totalPages : totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= (view === 'incomplete' ? dq!.pagination.totalPages : totalPages)}
              onClick={() => setPage((value) => Math.min(view === 'incomplete' ? dq!.pagination.totalPages : totalPages, value + 1))}
            >
              Proxima
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

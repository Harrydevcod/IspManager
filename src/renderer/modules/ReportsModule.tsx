import { Activity, Banknote, Cable, MessageCircle, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { authFetch } from '../lib/auth';
import { fallbackWhatsappTemplate, normalizeWhatsappPhone, renderWhatsappMessage, sendWhatsappViaUltraMsg } from '../lib/whatsapp';
import type { ReportsSummary, ReportView } from '../types';

type MessagingSettings = { companyName: string; whatsappTemplate: string };

export function ReportsModule() {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  const [view, setView] = useState<ReportView>('revenue');
  const [error, setError] = useState<string | null>(null);
  const [whatsappStatus, setWhatsappStatus] = useState<string | null>(null);
  const [messagingSettings, setMessagingSettings] = useState<MessagingSettings>({
    companyName: 'ISPM',
    whatsappTemplate: fallbackWhatsappTemplate
  });

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/reports/summary')
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
          <button className={view === 'revenue' ? 'active' : ''} type="button" onClick={() => setView('revenue')}>Receita</button>
          <button className={view === 'overdue' ? 'active' : ''} type="button" onClick={() => setView('overdue')}>Atrasos</button>
          <button className={view === 'stock' ? 'active' : ''} type="button" onClick={() => setView('stock')}>Stock</button>
          <button type="button" disabled={!summary} onClick={exportCsv}>Exportar CSV</button>
        </div>
      </div>

      {error && <p className="module-message error">{error}</p>}
      {whatsappStatus && <p className="module-message">{whatsappStatus}</p>}

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
              <strong>{row.clientName}</strong>
              <small>{row.clientCode} - {row.phone || 'sem telefone'}</small>
            </span>
            <small>{row.payments} cobrancas</small>
            <small>{row.amountCve.toLocaleString('pt-PT')} CVE</small>
            <button type="button" disabled={!normalizeWhatsappPhone(row.phone)} onClick={() => void sendOverdueWhatsapp(row)}>
              <MessageCircle size={16} />
              WhatsApp
            </button>
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
          <p className="module-message">Ainda nao existem pagamentos para reportar.</p>
        )}
        {summary && view === 'overdue' && summary.overdueClients.length === 0 && (
          <p className="module-message">Nao existem clientes em atraso.</p>
        )}
        {summary && view === 'stock' && summary.stockRows.length === 0 && (
          <p className="module-message">Ainda nao existem equipamentos cadastrados.</p>
        )}
      </div>
    </section>
  );
}

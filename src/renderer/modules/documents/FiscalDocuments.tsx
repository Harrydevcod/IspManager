import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FilePlus2, Printer } from "lucide-react";
import { Button, Field, Select } from "../../components";
import { authFetch } from "../../lib/auth";
import {
  downloadAuthenticated,
  printAuthenticated,
  useAuthenticatedObjectUrl,
} from "../../lib/download";
import { formatCve, formatPtDate } from "../../lib/format";
import {
  FISCAL_TYPE_LABELS,
  type FiscalDocument,
  type FiscalDocumentList,
} from "../../../shared/fiscal-documents";
import { ManualInvoiceDialog } from "../payments/ManualInvoiceDialog";
import { SaleTicketDialog } from "../payments/SaleTicketDialog";
import { SaleTicketDetailDialog } from "../payments/SaleTicketDetailDialog";
const API = "http://127.0.0.1:3001/api";
const STATUS_LABELS = {
  pending: "Pendente",
  overdue: "Em atraso",
  paid: "Paga",
  issued: "Emitido",
  cancelled: "Anulado",
};
export function fiscalPdfUrl(doc: FiscalDocument) {
  return doc.documentType === "receipt" && doc.source === "receipt"
    ? `${API}/receipts/${doc.sourceId}/receipt.pdf?archive=1`
    : `${API}/payments/${doc.paymentId}/${doc.documentType === "receipt" ? "receipt" : "invoice"}.pdf?archive=1`;
}
export function FiscalDocuments({
  active,
  onOpenPayment,
}: {
  active: boolean;
  onOpenPayment: (id: number) => void;
}) {
  const [list, setList] = useState<FiscalDocumentList | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [clientId, setClientId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [clients, setClients] = useState<
    Array<{ id: number; fullName: string }>
  >([]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FiscalDocument | null>(null);
  const [related, setRelated] = useState<FiscalDocument[]>([]);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const documentLock = useRef(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    authFetch(`${API}/clients`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Não foi possível carregar os clientes.");
        return response.json();
      })
      .then((body) => {
        if (!controller.signal.aborted) setClients(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      const query = new URLSearchParams({
        page: String(page),
        pageSize: "25",
        ...(search ? { search } : {}),
        ...(type ? { documentType: type } : {}),
        ...(status ? { status } : {}),
        ...(clientId ? { clientId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
      authFetch(`${API}/documents/fiscal?${query}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Não foi possível carregar os documentos.");
          return response.json() as Promise<FiscalDocumentList>;
        })
        .then((body) => {
          if (!controller.signal.aborted) setList(body);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, search, type, status, clientId, from, to, page, refreshKey]);
  useEffect(() => {
    setRelated([]);
    if (!selected || selected.documentType === "sale_ticket") return;
    const controller = new AbortController();
    authFetch(
      `${API}/documents/fiscal?paymentId=${selected.paymentId}&documentType=receipt&pageSize=100`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Não foi possível carregar os recibos associados.");
        return response.json() as Promise<FiscalDocumentList>;
      })
      .then((body) => {
        if (!controller.signal.aborted) setRelated(body.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [selected]);
  const pdfUrl =
    selected && selected.documentType !== "sale_ticket"
      ? fiscalPdfUrl(selected)
      : null;
  const preview = useAuthenticatedObjectUrl(
    pdfUrl ? `${pdfUrl}&inline=1&state=${selected?.status}` : null,
  );
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  async function documentAction(kind: "download" | "print") {
    if (!selected || !pdfUrl || documentLock.current) return;
    documentLock.current = true;
    setDocumentBusy(true);
    setError("");
    try {
      if (kind === "download")
        await downloadAuthenticated(pdfUrl, `${selected.number}.pdf`);
      else await printAuthenticated(pdfUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      documentLock.current = false;
      setDocumentBusy(false);
    }
  }
  async function created(paymentId: number, warning?: string) {
    setInvoiceOpen(false);
    setTicketOpen(false);
    setSearch("");
    setType("");
    setStatus("");
    setClientId("");
    setFrom("");
    setTo("");
    setPage(1);
    refresh();
    try {
      const response = await authFetch(
        `${API}/documents/fiscal?paymentId=${paymentId}`,
      );
      if (!response.ok)
        throw new Error(
          "O documento foi emitido, mas não foi possível abrir o detalhe. Atualize a lista.",
        );
      const result = (await response.json()) as FiscalDocumentList;
      const document = result.items.find(
        (item) => item.documentType !== "receipt",
      );
      if (document) setSelected(document);
      if (warning) setError(warning);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function filter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(1);
    setList(null);
  }
  return (
    <section className="fiscal-workspace" aria-label="Documentos fiscais">
      <header className="proposal-header">
        <div>
          <span className="proposal-eyebrow">FATURAÇÃO</span>
          <h2>{selected?.number ?? "Fiscais"}</h2>
          <p>Faturas, recibos e talões de venda</p>
        </div>
        <div className="proposal-actions">
          {selected ? (
            <Button
              variant="secondary"
              leadingIcon={<ArrowLeft size={16} />}
              onClick={() => setSelected(null)}
            >
              Voltar à lista
            </Button>
          ) : (
            <>
              <Button
                leadingIcon={<FilePlus2 size={16} />}
                onClick={() => setInvoiceOpen(true)}
              >
                Nova fatura
              </Button>
              <Button
                variant="secondary"
                leadingIcon={<FilePlus2 size={16} />}
                onClick={() => setTicketOpen(true)}
              >
                Novo talão de venda
              </Button>
            </>
          )}
        </div>
      </header>
      {error && (
        <div className="proposal-error" role="alert">
          {error}
          <Button variant="ghost" onClick={refresh}>
            Atualizar
          </Button>
        </div>
      )}
      {!selected ? (
        <>
          <div className="fiscal-filters">
            <Field
              label="Pesquisar número ou cliente"
              type="search"
              value={search}
              onChange={(e) => filter(setSearch, e.target.value)}
            />
            <Select
              label="Tipo"
              value={type}
              onChange={(e) => filter(setType, e.target.value)}
            >
              <option value="">Todos os tipos</option>
              {Object.entries(FISCAL_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              label="Estado"
              value={status}
              onChange={(e) => filter(setStatus, e.target.value)}
            >
              <option value="">Todos os estados</option>
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              label="Cliente"
              value={clientId}
              onChange={(e) => filter(setClientId, e.target.value)}
            >
              <option value="">Todos os clientes</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.fullName}
                </option>
              ))}
            </Select>
            <Field
              label="Desde"
              type="date"
              value={from}
              onChange={(e) => filter(setFrom, e.target.value)}
            />
            <Field
              label="Até"
              type="date"
              value={to}
              onChange={(e) => filter(setTo, e.target.value)}
            />
          </div>
          <div className="fiscal-list" aria-busy={loading}>
            {!list ? (
              <p>
                {loading
                  ? "A carregar documentos…"
                  : "Selecione os filtros ou aguarde a consulta."}
              </p>
            ) : !list.items.length ? (
              <p>Nenhum documento emitido neste período.</p>
            ) : (
              list.items.map((doc) => (
                <Button
                  variant="ghost"
                  className="fiscal-row"
                  key={`${doc.documentType}:${doc.source}:${doc.sourceId}`}
                  onClick={() => setSelected(doc)}
                >
                  <div>
                    <span className="entity-code">{doc.number}</span>
                    <strong>{doc.clientName}</strong>
                    <span>{FISCAL_TYPE_LABELS[doc.documentType]}</span>
                  </div>
                  <div>
                    <span>{formatPtDate(doc.date)}</span>
                    <span>{STATUS_LABELS[doc.status]}</span>
                  </div>
                  <strong>{formatCve(doc.amountCve)}</strong>
                </Button>
              ))
            )}
          </div>
          {list && (
            <div className="fiscal-pagination">
              <span>
                {list.total} documentos · Página {page} de{" "}
                {Math.max(1, Math.ceil(list.total / 25))}
              </span>
              <Button
                variant="secondary"
                disabled={page === 1 || loading}
                onClick={() => setPage(page - 1)}
              >
                Anterior
              </Button>
              <Button
                variant="secondary"
                disabled={page * 25 >= list.total || loading}
                onClick={() => setPage(page + 1)}
              >
                Seguinte
              </Button>
            </div>
          )}
        </>
      ) : (
        selected.documentType !== "sale_ticket" && (
          <div className="fiscal-detail">
            <aside>
              <span className="proposal-eyebrow">
                {FISCAL_TYPE_LABELS[selected.documentType]}
              </span>
              <h3>{selected.clientName}</h3>
              <p>
                {formatPtDate(selected.date)} · {STATUS_LABELS[selected.status]}
              </p>
              <strong className="fiscal-amount">
                {formatCve(selected.amountCve)}
              </strong>
              <div className="proposal-actions">
                <Button
                  variant="secondary"
                  disabled={documentBusy}
                  leadingIcon={<Download size={16} />}
                  onClick={() => void documentAction("download")}
                >
                  Guardar PDF
                </Button>
                <Button
                  variant="secondary"
                  disabled={documentBusy}
                  leadingIcon={<Printer size={16} />}
                  onClick={() => void documentAction("print")}
                >
                  Imprimir
                </Button>
              </div>
              <Button onClick={() => onOpenPayment(selected.paymentId)}>
                Abrir no Financeiro
              </Button>
              <h4>Recibos associados</h4>
              {related.length ? (
                related.map((doc) => (
                  <Button
                    variant="ghost"
                    key={`${doc.source}:${doc.sourceId}`}
                    onClick={() => setSelected(doc)}
                  >
                    {doc.number} · {formatCve(doc.amountCve)} ·{" "}
                    {STATUS_LABELS[doc.status]}
                  </Button>
                ))
              ) : (
                <p>Sem recibos associados.</p>
              )}
            </aside>
            <div className="fiscal-preview">
              {preview.error ? (
                <p role="alert">Não foi possível carregar o PDF.</p>
              ) : preview.objectUrl ? (
                <iframe
                  title={`Pré-visualização de ${selected.number}`}
                  src={`${preview.objectUrl}#toolbar=0`}
                />
              ) : (
                <p>A preparar PDF…</p>
              )}
            </div>
          </div>
        )
      )}
      <ManualInvoiceDialog
        open={invoiceOpen}
        onClose={() => setInvoiceOpen(false)}
        onCreated={created}
      />
      <SaleTicketDialog
        open={ticketOpen}
        onClose={() => setTicketOpen(false)}
        onCreated={created}
      />
      {selected?.documentType === "sale_ticket" && (
        <SaleTicketDetailDialog
          payment={{
            id: selected.paymentId,
            status: selected.status === "cancelled" ? "cancelled" : "paid",
            invoiceNumber: selected.number,
          }}
          onClose={() => setSelected(null)}
          onCancelled={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

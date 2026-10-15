import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  FileText,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Field, Select, Textarea, useConfirm } from "../../components";
import { authFetch, useAuth } from "../../lib/auth";
import { downloadAuthenticated } from "../../lib/download";
import { formatCve, formatPtDate } from "../../lib/format";
import type { Client, PlanRow, StockCatalogRow } from "../../types";
import {
  INFORMATIVE_TYPE_LABELS,
  type InformativeDocumentType,
  PROPOSAL_STATUS_LABELS,
  type Proposal,
  type ProposalAction,
  type ProposalDraftInput,
  type ProposalLineInput,
  type ProposalList,
} from "../../../shared/proposals";
import {
  lineTotalCentavos,
  actionPayload,
  draftFromProposal,
  newDraft,
  planLines,
  productLine,
  proposalTotals,
  validateDraft,
  parsePaymentAmount,
} from "./draft";
import "./ProposalsModule.css";

const API = "http://127.0.0.1:3001/api";
const actionLabels: Record<ProposalAction, string> = {
  issue: "Emitir proposta",
  deliver: "Registar entrega",
  accept: "Registar aceitação",
  refuse: "Registar recusa",
  cancel: "Cancelar proposta",
  revise: "Criar revisão",
};
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await authFetch(`${API}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? `${result.error || result.message || "Esta proposta foi alterada por outro utilizador."} Os seus dados continuam no formulário. Abra a versão atual antes de continuar.`
        : result.error ||
          result.message ||
          "Não foi possível concluir a operação.",
    );
  return result;
}

export function ProposalsModule({
  initialClient,
  onInitialClientHandled,
}: {
  initialClient?: Client | null;
  onInitialClientHandled?: () => void;
}) {
  const auth = useAuth();
  const permitted = auth.isAuthBypassed || auth.hasRole("admin", "operator");
  const confirm = useConfirm();
  const [list, setList] = useState<ProposalList | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState<ProposalDraftInput | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [products, setProducts] = useState<StockCatalogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfFormat, setPdfFormat] = useState<"a5" | "a4">("a5");
  const [action, setAction] = useState<ProposalAction | null>(null);
  const [reason, setReason] = useState("");
  const [actor, setActor] = useState("");
  const [channel, setChannel] = useState("WhatsApp");
  const [deliveredAt, setDeliveredAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [documentTypeFilter, setDocumentTypeFilter] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [productPeriod, setProductPeriod] = useState<"once" | "monthly">(
    "once",
  );
  const listRequest = useRef(0);
  const refresh = useCallback(async () => {
    if (!permitted) return;
    const requestId = ++listRequest.current;
    try {
      const result = await request<ProposalList>(
        `/proposals?${new URLSearchParams({ search, ...(status ? { status } : {}), ...(documentTypeFilter ? { documentType: documentTypeFilter } : {}), page: String(page), pageSize: "25" })}`,
      );
      if (requestId === listRequest.current) setList(result);
    } catch (e) {
      if (requestId === listRequest.current) setError((e as Error).message);
    }
  }, [search, status, documentTypeFilter, page, permitted]);
  useEffect(() => {
    const pendingRequests = listRequest;
    const timer = setTimeout(() => void refresh(), 200);
    return () => {
      clearTimeout(timer);
      pendingRequests.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!permitted) return;
    let alive = true;
    Promise.allSettled([
      request<Client[]>("/clients"),
      request<PlanRow[]>("/plans"),
      request<{ rows: StockCatalogRow[] }>("/stock/summary"),
    ])
      .then(([c, p, s]) => {
        if (alive) {
          if (c.status === "fulfilled")
            setClients(c.value.filter((v) => !v.systemKind));
          if (p.status === "fulfilled")
            setPlans(p.value.filter((v) => v.active));
          if (s.status === "fulfilled")
            setProducts(s.value.rows.filter((v) => v.active));
          const unavailable = [
            c.status === "rejected" ? "clientes" : "",
            p.status === "rejected" ? "planos" : "",
            s.status === "rejected" ? "produtos" : "",
          ].filter(Boolean);
          if (unavailable.length)
            setError(
              `Não foi possível carregar ${unavailable.join(", ")}. Pode continuar com os restantes dados ou acrescentar linhas livres.`,
            );
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [permitted]);
  useEffect(() => {
    if (initialClient && permitted) {
      setDraft(newDraft(initialClient));
      setSelected(null);
      onInitialClientHandled?.();
    }
  }, [initialClient, permitted, onInitialClientHandled]);
  async function open(id: number) {
    setBusy(true);
    setError(null);
    try {
      const proposal = await request<Proposal>(`/proposals/${id}`);
      setSelected(proposal);
      setPaymentAmount(
        proposal.paymentRequest
          ? String(proposal.paymentRequest.amountCentavos / 100)
          : "",
      );
      setDraft(
        proposal.status === "draft" ? draftFromProposal(proposal) : null,
      );
      setAction(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(): Promise<Proposal | null> {
    if (!draft) return selected;
    const invalid = validateDraft(draft);
    if (invalid) {
      setError(invalid);
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const proposal = await request<Proposal>(
        selected ? `/proposals/${selected.id}` : "/proposals",
        selected ? "PATCH" : "POST",
        { ...draft, ...(selected ? { version: selected.version } : {}) },
      );
      setSelected(proposal);
      void refresh();
      return proposal;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function perform(target: ProposalAction) {
    if (target === "issue") {
      const proposal = await save();
      if (!proposal) return;
      if (
        !(await confirm({
          title: `Emitir ${INFORMATIVE_TYPE_LABELS[proposal.documentType ?? "proposal"].toLocaleLowerCase("pt")}?`,
          message: `${proposal.recipient.name} · Custos únicos ${formatCve(proposal.onceTotalCentavos / 100)} · Mensalidade ${formatCve(proposal.monthlyTotalCentavos / 100)}. O destinatário, os preços e as condições ficam congelados após a emissão.`,
          confirmLabel: `Emitir ${INFORMATIVE_TYPE_LABELS[proposal.documentType ?? "proposal"].toLocaleLowerCase("pt")}`,
        }))
      )
        return;
      await mutate(target, proposal);
      return;
    }
    if (target === "revise") {
      if (selected) await mutate(target, selected);
      return;
    }
    setAction(target);
    setReason("");
    setActor("");
  }
  async function mutate(target: ProposalAction, proposal: Proposal) {
    setBusy(true);
    setError(null);
    const body = actionPayload(target, proposal.version, {
      deliveredAt,
      channel,
      reason,
      actor,
    });
    try {
      const result = await request<Proposal>(
        `/proposals/${proposal.id}/${target}`,
        "POST",
        body,
      );
      setSelected(result);
      setPaymentAmount(
        result.paymentRequest
          ? String(result.paymentRequest.amountCentavos / 100)
          : "",
      );
      setDraft(result.status === "draft" ? draftFromProposal(result) : null);
      setAction(null);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pdf() {
    const proposal = draft ? await save() : selected;
    if (!proposal) return;
    setBusy(true);
    try {
      await downloadAuthenticated(
        `${API}/proposals/${proposal.id}/proposal.pdf?format=${pdfFormat}`,
        `${proposal.number ?? "Rascunho"}-${({ proposal: "proposta", quotation: "orcamento", proforma: "proforma" } as const)[proposal.documentType ?? "proposal"]}-${pdfFormat}.pdf`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function back() {
    if (
      draft &&
      !(await confirm({
        title: "Voltar à lista?",
        message:
          "Guarde o rascunho para preservar as alterações. Voltar descarta alterações ainda não guardadas.",
        confirmLabel: "Voltar à lista",
      }))
    )
      return;
    setDraft(null);
    setSelected(null);
    setAction(null);
    setError(null);
    void refresh();
  }
  function updateLine(index: number, patch: Partial<ProposalLineInput>) {
    setDraft(
      (d) =>
        d && {
          ...d,
          lines: d.lines.map((line, i) =>
            i === index ? { ...line, ...patch } : line,
          ),
        },
    );
  }
  function append(lines: ProposalLineInput[]) {
    if (!draft) return;
    if (draft.lines.length + lines.length > 100) {
      setError("A proposta admite no máximo 100 linhas.");
      return;
    }
    setDraft({ ...draft, lines: [...draft.lines, ...lines] });
  }
  function reorder(index: number, delta: number) {
    if (!draft) return;
    const lines = [...draft.lines];
    [lines[index], lines[index + delta]] = [lines[index + delta], lines[index]];
    setDraft({ ...draft, lines });
  }
  async function changeType(documentType: InformativeDocumentType) {
    if (!draft || selected?.previousId) return;
    const request = draft.paymentRequest;
    if (
      draft.documentType === "proforma" &&
      documentType !== "proforma" &&
      request &&
      (paymentAmount ||
        request.description ||
        request.conditions ||
        request.dueDate)
    ) {
      if (
        !(await confirm({
          title: "Limpar pedido de pagamento?",
          message:
            "Ao alterar o tipo, o montante e as instruções de pagamento serão removidos.",
          confirmLabel: "Alterar e limpar",
        }))
      )
        return;
    }
    setPaymentAmount("");
    setDraft({
      ...draft,
      documentType,
      title:
        draft.title ===
        INFORMATIVE_TYPE_LABELS[draft.documentType ?? "proposal"]
          ? INFORMATIVE_TYPE_LABELS[documentType]
          : draft.title,
      paymentRequest:
        documentType === "proforma"
          ? {
              amountCentavos: 0,
              description: "",
              conditions: "",
              dueDate: null,
            }
          : null,
    });
  }
  if (!permitted)
    return <p role="alert">Sem acesso às propostas comerciais.</p>;
  const documentType =
    draft?.documentType ?? selected?.documentType ?? "proposal";
  const typeLabel = INFORMATIVE_TYPE_LABELS[documentType];
  const displayAction = (action: ProposalAction) =>
    action === "issue"
      ? `Emitir ${typeLabel.toLocaleLowerCase("pt")}`
      : action === "cancel"
        ? `Cancelar ${typeLabel.toLocaleLowerCase("pt")}`
        : actionLabels[action];
  const totals = draft
    ? proposalTotals(draft.lines)
    : {
        once: selected?.onceTotalCentavos ?? 0,
        monthly: selected?.monthlyTotalCentavos ?? 0,
      };
  const money = (centavos: number) =>
    selected?.snapshot && selected.snapshot.company.currencyCode !== "CVE"
      ? new Intl.NumberFormat("pt-PT", {
          style: "currency",
          currency: selected.snapshot.company.currencyCode,
        }).format(centavos / 100)
      : formatCve(centavos / 100);
  return (
    <section
      className="proposals-workspace"
      aria-label="Documentos informativos"
    >
      <header className="proposal-header">
        <div>
          <span className="proposal-eyebrow">COMERCIAL</span>
          <h2>{selected?.number ?? (draft ? typeLabel : "Informativos")}</h2>
          <p>
            {draft || selected
              ? `${typeLabel} — não constitui fatura${documentType === "proforma" ? " fiscal" : ""}`
              : "Propostas, orçamentos e proformas"}
          </p>
        </div>
        <div className="proposal-actions">
          {draft || selected ? (
            <Button
              variant="secondary"
              onClick={() => void back()}
              disabled={busy}
              leadingIcon={<ArrowLeft size={16} />}
            >
              Informativos
            </Button>
          ) : (
            <Button
              onClick={() => {
                setPaymentAmount("");
                setDraft(newDraft());
                setError(null);
              }}
              leadingIcon={<Plus size={16} />}
            >
              Nova proposta
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="proposal-error" role="alert">
          {error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            Atualizar lista
          </Button>
        </div>
      )}
      {!draft && !selected && (
        <>
          <div className="proposal-filters">
            <Select
              label="Tipo de documento"
              value={documentTypeFilter}
              onChange={(event) => {
                setDocumentTypeFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos os tipos</option>
              {Object.entries(INFORMATIVE_TYPE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Field
              label="Pesquisar número ou destinatário"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <Select
              label="Estado"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Todos os estados</option>
              {Object.entries(PROPOSAL_STATUS_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div className="proposal-list" aria-busy={busy}>
            {!list ? (
              <p>A carregar propostas…</p>
            ) : !list.items.length ? (
              <div className="proposal-empty">
                <FileText size={28} />
                <h3>A próxima oferta começa aqui</h3>
                <p>
                  Apresente instalação, equipamento e mensalidades numa proposta
                  para um cliente ou interessado.
                </p>
              </div>
            ) : (
              list.items.map((p) => (
                <Button
                  variant="ghost"
                  className="proposal-list-row"
                  key={p.id}
                  onClick={() => void open(p.id)}
                  disabled={busy}
                >
                  <div>
                    <span className="entity-code">
                      {p.number ?? "RASCUNHO"}
                    </span>
                    <strong>{p.recipientName}</strong>
                    <span>
                      {INFORMATIVE_TYPE_LABELS[p.documentType ?? "proposal"]} ·{" "}
                      {p.title}
                    </span>
                  </div>
                  <div>
                    <span>{PROPOSAL_STATUS_LABELS[p.status]}</span>
                    <span>Válida até {formatPtDate(p.validUntil)}</span>
                  </div>
                  <div>
                    <span>
                      Custos únicos{" "}
                      <strong>{formatCve(p.onceTotalCentavos / 100)}</strong>
                    </span>
                    <span>
                      Mensal{" "}
                      <strong>{formatCve(p.monthlyTotalCentavos / 100)}</strong>
                    </span>
                  </div>
                </Button>
              ))
            )}
          </div>
          {list && (
            <div className="proposal-pagination">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Anterior
              </Button>
              <span>
                Página {page} · {list.total} propostas
              </span>
              <Button
                variant="secondary"
                disabled={page * list.pageSize >= list.total}
                onClick={() => setPage(page + 1)}
              >
                Seguinte
              </Button>
            </div>
          )}
        </>
      )}
      {(draft || selected) && (
        <div className="proposal-layout">
          <main className="proposal-content">
            {draft ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
                id="proposal-draft"
              >
                <fieldset disabled={busy}>
                  <h3>Destinatário</h3>
                  <Select
                    label="Cliente existente ou interessado"
                    value={draft.clientId ?? ""}
                    onChange={(e) => {
                      const client = clients.find(
                        (c) => c.id === Number(e.target.value),
                      );
                      const recipient = newDraft(client).recipient;
                      setDraft({
                        ...draft,
                        clientId: client?.id ?? null,
                        recipient,
                      });
                    }}
                  >
                    <option value="">Interessado — sem registo</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fullName} · {c.clientCode}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label="Tipo de documento"
                    value={draft.documentType ?? "proposal"}
                    disabled={!!selected?.previousId}
                    onChange={(event) =>
                      void changeType(
                        event.target.value as InformativeDocumentType,
                      )
                    }
                  >
                    {Object.entries(INFORMATIVE_TYPE_LABELS).map(
                      ([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ),
                    )}
                  </Select>
                  <div className="proposal-fields">
                    {(
                      ["name", "nif", "phone", "email", "address"] as const
                    ).map((key) => (
                      <Field
                        key={key}
                        label={
                          {
                            name: "Nome do destinatário",
                            nif: "NIF (opcional)",
                            phone: "Telefone",
                            email: "Email",
                            address: "Morada",
                          }[key]
                        }
                        value={draft.recipient[key]}
                        required={key === "name"}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            recipient: {
                              ...draft.recipient,
                              [key]: e.target.value,
                            },
                          })
                        }
                      />
                    ))}
                    <Field
                      label="Título"
                      value={draft.title}
                      required
                      onChange={(e) =>
                        setDraft({ ...draft, title: e.target.value })
                      }
                    />
                    <Field
                      label="Válida até"
                      type="date"
                      required
                      value={draft.validUntil}
                      onChange={(e) =>
                        setDraft({ ...draft, validUntil: e.target.value })
                      }
                    />
                  </div>
                  <h3>Composição da oferta</h3>
                  <div className="proposal-add">
                    <Select
                      label="Acrescentar plano"
                      value=""
                      onChange={(e) => {
                        const plan = plans.find(
                          (p) => p.id === Number(e.target.value),
                        );
                        if (plan) append(planLines(plan));
                      }}
                    >
                      <option value="">Plano + instalação</option>
                      {plans.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Modalidade do produto"
                      value={productPeriod}
                      onChange={(e) =>
                        setProductPeriod(e.target.value as "once" | "monthly")
                      }
                    >
                      <option value="once">Venda única</option>
                      <option value="monthly">Aluguer mensal</option>
                    </Select>
                    <Select
                      label="Acrescentar produto"
                      value=""
                      onChange={(e) => {
                        const product = products.find(
                          (p) => p.id === Number(e.target.value),
                        );
                        if (product)
                          append([productLine(product, productPeriod)]);
                      }}
                    >
                      <option value="">Produto do catálogo</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.brand} {p.model}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        append([
                          {
                            kind: "free",
                            description: "",
                            period: "once",
                            quantity: 1,
                            unitPriceCentavos: 0,
                          },
                        ])
                      }
                    >
                      Linha livre
                    </Button>
                  </div>
                  <div className="proposal-lines">
                    {draft.lines.map((line, i) => (
                      <div className="proposal-line" key={i}>
                        <Field
                          label={`Descrição ${i + 1}`}
                          value={line.description}
                          required
                          onChange={(e) =>
                            updateLine(i, { description: e.target.value })
                          }
                        />
                        <Select
                          label={`Periodicidade ${i + 1}`}
                          value={line.period}
                          disabled={
                            line.kind === "plan" || line.kind === "installation"
                          }
                          onChange={(e) =>
                            updateLine(i, {
                              period: e.target.value as "once" | "monthly",
                            })
                          }
                        >
                          <option value="once">Custo único</option>
                          <option value="monthly">Mensal</option>
                        </Select>
                        <Field
                          label={`Quantidade ${i + 1}`}
                          type="number"
                          min={
                            line.kind === "plan" || line.kind === "installation"
                              ? "1"
                              : "0.001"
                          }
                          step={
                            line.kind === "plan" || line.kind === "installation"
                              ? "1"
                              : "0.001"
                          }
                          value={line.quantity}
                          onChange={(e) =>
                            updateLine(i, { quantity: Number(e.target.value) })
                          }
                        />
                        <Field
                          label={`Preço unitário ${i + 1} (CVE)`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.unitPriceCentavos / 100}
                          onChange={(e) =>
                            updateLine(i, {
                              unitPriceCentavos: Math.round(
                                Number(e.target.value) * 100,
                              ),
                            })
                          }
                        />
                        <div className="proposal-line-tools">
                          <strong>{money(lineTotalCentavos(line))}</strong>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Subir linha ${i + 1}`}
                            disabled={i === 0}
                            onClick={() => reorder(i, -1)}
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Descer linha ${i + 1}`}
                            disabled={i === draft.lines.length - 1}
                            onClick={() => reorder(i, 1)}
                          >
                            <ArrowDown size={14} />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Remover linha ${i + 1}`}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                lines: draft.lines.filter(
                                  (_, index) => index !== i,
                                ),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {draft.documentType === "proforma" &&
                    draft.paymentRequest && (
                      <section className="proposal-payment-request">
                        <h3>Pedido de pagamento antecipado</h3>
                        <p>
                          Indique o período e os serviços abrangidos. Este
                          pedido não confirma recebimento.
                        </p>
                        <Field
                          label="Montante a pagar antecipadamente (CVE)"
                          required
                          inputMode="decimal"
                          value={paymentAmount}
                          onChange={(event) => {
                            setPaymentAmount(event.target.value);
                            setDraft({
                              ...draft,
                              paymentRequest: {
                                ...draft.paymentRequest!,
                                amountCentavos:
                                  parsePaymentAmount(event.target.value) ?? 0,
                              },
                            });
                          }}
                        />
                        <Textarea
                          label="O que este pagamento cobre"
                          required
                          maxLength={12000}
                          rows={3}
                          value={draft.paymentRequest.description}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              paymentRequest: {
                                ...draft.paymentRequest!,
                                description: event.target.value,
                              },
                            })
                          }
                        />
                        <Textarea
                          label="Condições de pagamento"
                          required
                          maxLength={12000}
                          rows={4}
                          value={draft.paymentRequest.conditions}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              paymentRequest: {
                                ...draft.paymentRequest!,
                                conditions: event.target.value,
                              },
                            })
                          }
                        />
                        <Field
                          label="Data limite de pagamento (opcional)"
                          type="date"
                          value={draft.paymentRequest.dueDate ?? ""}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              paymentRequest: {
                                ...draft.paymentRequest!,
                                dueDate: event.target.value || null,
                              },
                            })
                          }
                        />
                      </section>
                    )}
                  <Textarea
                    label="Condições comerciais"
                    rows={5}
                    value={draft.conditions}
                    onChange={(e) =>
                      setDraft({ ...draft, conditions: e.target.value })
                    }
                  />
                </fieldset>
              </form>
            ) : (
              selected && (
                <>
                  <div className="proposal-recipient">
                    <span className="proposal-status">
                      {PROPOSAL_STATUS_LABELS[selected.status]}
                    </span>
                    <h3>{selected.recipient.name}</h3>
                    <p>
                      {[
                        selected.recipient.nif &&
                          `NIF ${selected.recipient.nif}`,
                        selected.recipient.phone,
                        selected.recipient.email,
                        selected.recipient.address,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p>
                      {selected.title} · Válida até{" "}
                      {formatPtDate(selected.validUntil)}
                    </p>
                  </div>
                  {(["once", "monthly"] as const).map((period) => (
                    <section key={period} className="proposal-section">
                      <h3>
                        {period === "once" ? "Custos únicos" : "Mensalidades"}
                      </h3>
                      {selected.lines
                        .filter((l) => l.period === period)
                        .map((line) => (
                          <div className="proposal-fixed-line" key={line.id}>
                            <div>
                              <strong>{line.description}</strong>
                              <span>
                                {line.quantity} ×{" "}
                                {money(line.unitPriceCentavos)}
                              </span>
                            </div>
                            <strong>{money(line.totalCentavos)}</strong>
                          </div>
                        ))}
                    </section>
                  ))}
                  {selected.documentType === "proforma" &&
                    selected.paymentRequest && (
                      <section className="proposal-payment-request">
                        <h3>Pedido de pagamento antecipado</h3>
                        <strong>
                          {formatCve(
                            selected.paymentRequest.amountCentavos / 100,
                          )}{" "}
                          CVE
                        </strong>
                        <h4>O que este pagamento cobre</h4>
                        <p className="proposal-conditions">
                          {selected.paymentRequest.description}
                        </p>
                        <h4>Condições de pagamento</h4>
                        <p className="proposal-conditions">
                          {selected.paymentRequest.conditions}
                        </p>
                        {selected.paymentRequest.dueDate && (
                          <p>
                            Data limite:{" "}
                            {formatPtDate(selected.paymentRequest.dueDate)}
                          </p>
                        )}
                      </section>
                    )}
                  <h3>Condições comerciais</h3>
                  <p className="proposal-conditions">
                    {selected.conditions || "Sem condições adicionais."}
                  </p>
                  {selected.decisionAt && (
                    <section className="proposal-section">
                      <h3>Decisão do cliente</h3>
                      <p>
                        {selected.acceptedBy} ·{" "}
                        {formatPtDate(selected.decisionAt)}
                      </p>
                      <p>{selected.decisionNote}</p>
                    </section>
                  )}
                  {selected.cancellationReason && (
                    <p>Motivo do cancelamento: {selected.cancellationReason}</p>
                  )}
                  <section className="proposal-section">
                    <h3>Entregas registadas</h3>
                    {selected.deliveries.length ? (
                      selected.deliveries.map((d) => (
                        <p key={d.id}>
                          {formatPtDate(d.deliveredAt)} · {d.channel}
                          {d.note && ` · ${d.note}`}
                        </p>
                      ))
                    ) : (
                      <p>Nenhuma entrega registada.</p>
                    )}
                  </section>
                </>
              )
            )}
            {selected && selected.chain.length > 1 && (
              <section className="proposal-section">
                <h3>Revisões</h3>
                <div className="proposal-actions">
                  {selected.chain.map((p) => (
                    <Button
                      key={p.id}
                      variant="secondary"
                      disabled={busy || p.id === selected.id}
                      onClick={() => void open(p.id)}
                    >
                      {p.number ?? "Rascunho"} ·{" "}
                      {PROPOSAL_STATUS_LABELS[p.status]}
                    </Button>
                  ))}
                </div>
              </section>
            )}
            {action && selected && (
              <form
                className="proposal-action-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(action, selected);
                }}
              >
                <h3>{displayAction(action)}</h3>
                {action === "deliver" && (
                  <>
                    <Field
                      label="Data de entrega"
                      type="date"
                      required
                      value={deliveredAt}
                      onChange={(e) => setDeliveredAt(e.target.value)}
                    />
                    <Field
                      label="Canal de entrega"
                      required
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                    />
                  </>
                )}
                {action === "accept" && (
                  <Field
                    label="Quem aceitou"
                    required
                    value={actor}
                    onChange={(e) => setActor(e.target.value)}
                  />
                )}
                <Textarea
                  label={
                    action === "cancel" || action === "refuse"
                      ? "Motivo obrigatório"
                      : "Nota de confirmação / observação"
                  }
                  required={action === "cancel" || action === "refuse"}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="proposal-actions">
                  <Button type="submit" disabled={busy}>
                    Confirmar registo
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setAction(null)}
                  >
                    Voltar
                  </Button>
                </div>
              </form>
            )}
          </main>
          <aside className="proposal-summary">
            <span className="proposal-eyebrow">
              {typeLabel.toLocaleUpperCase("pt")}
            </span>
            <h3>{draft ? "Resumo do rascunho" : "Valores da oferta"}</h3>
            <div>
              <span>Total de custos únicos</span>
              <strong>{money(totals.once)}</strong>
            </div>
            <div>
              <span>Total mensal</span>
              <strong>{money(totals.monthly)}</strong>
            </div>
            <p>
              Preços com IVA incluído, quando aplicável. A data da primeira
              mensalidade depende das condições acordadas.
            </p>
            <div className="proposal-summary-actions">
              <Select
                label="Formato do PDF"
                value={pdfFormat}
                disabled={busy}
                onChange={(event) =>
                  setPdfFormat(event.target.value as "a5" | "a4")
                }
              >
                <option value="a5">A5</option>
                <option value="a4">A4</option>
              </Select>
              {draft && (
                <Button form="proposal-draft" type="submit" disabled={busy}>
                  Guardar rascunho
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void pdf()}
              >
                {draft ? "Pré-visualizar PDF · RASCUNHO" : "Guardar PDF"}
              </Button>
              {(
                selected?.allowedActions ??
                (draft ? (["issue"] as ProposalAction[]) : [])
              ).map((a) => (
                <Button
                  key={a}
                  variant={a === "issue" ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => void perform(a)}
                >
                  {displayAction(a)}
                </Button>
              ))}
            </div>
            {selected?.previousId && (
              <p>
                Revisão da proposta anterior. A emissão substitui a versão
                anterior.
              </p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

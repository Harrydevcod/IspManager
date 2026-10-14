import type {
  ProposalAction,
  Proposal,
  ProposalDraftInput,
  ProposalLineInput,
} from "../../../shared/proposals";
import type { Client, PlanRow, StockCatalogRow } from "../../types";

export function actionPayload(
  target: ProposalAction,
  version: number,
  data: { deliveredAt: string; channel: string; reason: string; actor: string },
) {
  if (target === "deliver")
    return {
      version,
      deliveredAt: new Date(`${data.deliveredAt}T12:00:00`).toISOString(),
      channel: data.channel,
      note: data.reason,
    };
  if (target === "accept")
    return { version, acceptedBy: data.actor, note: data.reason };
  if (target === "refuse" || target === "cancel")
    return { version, reason: data.reason };
  return { version };
}

export function newDraft(
  client?: Pick<
    Client,
    "id" | "fullName" | "phone" | "email" | "nif" | "address"
  >,
  now = new Date(),
): ProposalDraftInput {
  const valid = new Date(now);
  valid.setDate(valid.getDate() + 30);
  return {
    clientId: client?.id ?? null,
    title: "Proposta comercial",
    validUntil: `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, "0")}-${String(valid.getDate()).padStart(2, "0")}`,
    conditions: "",
    recipient: {
      name: client?.fullName ?? "",
      phone: client?.phone ?? "",
      email: client?.email ?? "",
      nif: client?.nif ?? "",
      address: client?.address ?? "",
    },
    lines: [],
  };
}
export function draftFromProposal(proposal: Proposal): ProposalDraftInput {
  return {
    clientId: proposal.clientId,
    recipient: { ...proposal.recipient },
    title: proposal.title,
    validUntil: proposal.validUntil,
    conditions: proposal.conditions,
    lines: proposal.lines.map(
      ({
        kind,
        description,
        period,
        quantity,
        unitPriceCentavos,
        planId,
        catalogId,
      }) => ({
        kind,
        description,
        period,
        quantity,
        unitPriceCentavos,
        planId,
        catalogId,
      }),
    ),
  };
}
export function planLines(
  plan: Pick<PlanRow, "id" | "name" | "monthlyPriceCve" | "installationFeeCve">,
): ProposalLineInput[] {
  return [
    {
      kind: "plan",
      description: plan.name,
      period: "monthly",
      quantity: 1,
      unitPriceCentavos: Math.round(plan.monthlyPriceCve * 100),
      planId: plan.id,
    },
    {
      kind: "installation",
      description: `Instalação — ${plan.name}`,
      period: "once",
      quantity: 1,
      unitPriceCentavos: Math.round(plan.installationFeeCve * 100),
      planId: plan.id,
    },
  ];
}
export function productLine(
  product: Pick<
    StockCatalogRow,
    "id" | "model" | "brand" | "sellingPriceCve" | "rentalFeeCve"
  >,
  period: "once" | "monthly",
): ProposalLineInput {
  return {
    kind: "product",
    description: [product.brand, product.model].filter(Boolean).join(" "),
    period,
    quantity: 1,
    unitPriceCentavos: Math.round(
      (period === "once" ? product.sellingPriceCve : product.rentalFeeCve) *
        100,
    ),
    catalogId: product.id,
  };
}
export function proposalTotals(lines: ProposalLineInput[]) {
  return lines.reduce(
    (totals, line) => {
      totals[line.period] += lineTotalCentavos(line);
      return totals;
    },
    { once: 0, monthly: 0 },
  );
}
/** Quantities use thousandths; half centavo rounds up just as on the server. */
export function lineTotalCentavos(
  line: Pick<ProposalLineInput, "quantity" | "unitPriceCentavos">,
): number {
  const quantityMillis = Math.round(line.quantity * 1000);
  if (
    !Number.isSafeInteger(quantityMillis) ||
    quantityMillis < 0 ||
    !Number.isSafeInteger(line.unitPriceCentavos) ||
    line.unitPriceCentavos < 0
  )
    return 0;
  const rounded =
    (BigInt(quantityMillis) * BigInt(line.unitPriceCentavos) + 500n) / 1000n;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : 0;
}
export function validateDraft(draft: ProposalDraftInput): string | null {
  if (!draft.recipient.name.trim()) return "Preencha o nome do destinatário.";
  if (!draft.title.trim() || !draft.validUntil)
    return "Preencha o título e a validade.";
  if (!draft.lines.length || draft.lines.length > 100)
    return "Inclua entre 1 e 100 linhas.";
  for (const line of draft.lines) {
    if (!line.description.trim())
      return "Preencha a descrição de todas as linhas.";
    if (
      !Number.isFinite(line.quantity) ||
      line.quantity <= 0 ||
      Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) >
        0.00001
    )
      return "A quantidade deve ser positiva, com até três casas decimais.";
    if (
      (line.kind === "plan" || line.kind === "installation") &&
      !Number.isInteger(line.quantity)
    )
      return "A quantidade de planos e instalações deve ser inteira.";
    if (
      !Number.isSafeInteger(line.unitPriceCentavos) ||
      line.unitPriceCentavos < 0
    )
      return "O preço deve ser positivo ou zero, com até duas casas decimais.";
  }
  const totals = proposalTotals(draft.lines);
  return totals.once > 0 || totals.monthly > 0
    ? null
    : "Pelo menos um dos totais deve ser positivo.";
}

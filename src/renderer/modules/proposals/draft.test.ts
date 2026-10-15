import { describe, expect, it, test } from "vitest";
import {
  actionPayload,
  lineTotalCentavos,
  draftFromProposal,
  newDraft,
  planLines,
  productLine,
  proposalTotals,
  validateDraft,
} from "./draft";
import type { Proposal } from "../../../shared/proposals";

describe("proposal composition", () => {
  it("rounds half centavo exactly, independent of floating point multiplication", () => {
    const line = {
      kind: "free" as const,
      description: "Cabo",
      period: "once" as const,
      quantity: 0.145,
      unitPriceCentavos: 100,
    };
    expect(lineTotalCentavos(line)).toBe(15);
    expect(proposalTotals([line, line])).toEqual({ once: 30, monthly: 0 });
    expect(lineTotalCentavos({ ...line, quantity: Number.NaN })).toBe(0);
  });
  it("sends only permitted action fields and an ISO delivery date", () => {
    const data = {
      deliveredAt: "2026-10-13",
      channel: "WhatsApp",
      reason: "Confirmado",
      actor: "Maria",
    };
    expect(actionPayload("issue", 2, data)).toEqual({ version: 2 });
    expect(actionPayload("revise", 2, data)).toEqual({ version: 2 });
    expect(actionPayload("accept", 2, data)).toEqual({
      version: 2,
      acceptedBy: "Maria",
      note: "Confirmado",
    });
    expect(actionPayload("cancel", 2, data)).toEqual({
      version: 2,
      reason: "Confirmado",
    });
    const delivery = actionPayload("deliver", 2, data);
    expect(delivery).toMatchObject({ channel: "WhatsApp", note: "Confirmado" });
    expect(
      "deliveredAt" in delivery &&
        typeof delivery.deliveredAt === "string" &&
        Number.isFinite(Date.parse(delivery.deliveredAt)),
    ).toBe(true);
  });
  it("projects stored and revised drafts into editable DTOs without database fields", () => {
    const proposal: Proposal = {
      ...newDraft(), documentType: "proposal", paymentRequest: null,
      id: 1,
      number: null,
      recipientName: "Maria",
      status: "draft",
      version: 2,
      issuedAt: null,
      createdAt: "2026-10-13",
      onceTotalCentavos: 100,
      monthlyTotalCentavos: 0,
      previousId: 5,
      snapshot: null,
      createdBy: 1,
      decisionAt: null,
      acceptedBy: null,
      decisionNote: null,
      cancellationReason: null,
      deliveries: [],
      chain: [],
      allowedActions: ["issue", "cancel"],
      lines: [
        {
          id: 100,
          sortOrder: 0,
          totalCentavos: 100,
          kind: "free",
          description: "Equipamento",
          period: "once",
          quantity: 1,
          unitPriceCentavos: 100,
          planId: null,
          catalogId: null,
        },
      ],
    };
    const draft = draftFromProposal(proposal);
    expect(Object.keys(draft.lines[0]).sort()).toEqual([
      "catalogId",
      "description",
      "kind",
      "period",
      "planId",
      "quantity",
      "unitPriceCentavos",
    ]);
    draft.lines[0].description = "Preço acordado";
    expect(proposal.lines[0].description).toBe("Equipamento");
    expect(
      JSON.stringify({ ...draft, documentType: "proposal", paymentRequest: null, version: proposal.version }),
    ).not.toContain("sortOrder");
  });
  it("keeps installation separate from the monthly plan, including free installation", () => {
    const lines = planLines({
      id: 8,
      name: "Fibra",
      monthlyPriceCve: 2500,
      installationFeeCve: 0,
    });
    expect(lines.map((l) => l.period)).toEqual(["monthly", "once"]);
    expect(proposalTotals(lines)).toEqual({ once: 0, monthly: 250000 });
  });
  it("uses selling and rental prices independently and rounds each fractional line", () => {
    const product = {
      id: 2,
      model: "Cabo",
      brand: null,
      sellingPriceCve: 1.01,
      rentalFeeCve: 2,
    };
    const sale = { ...productLine(product, "once"), quantity: 0.125 };
    expect(
      proposalTotals([sale, sale, productLine(product, "monthly")]),
    ).toEqual({ once: 26, monthly: 200 });
  });
  it("prefills an existing recipient and defaults to thirty days", () => {
    const draft = newDraft(
      { id: 4, fullName: "Maria", phone: "9911111" },
      new Date("2026-10-13T12:00:00Z"),
    );
    expect(draft.validUntil).toBe("2026-11-12");
    expect(draft.recipient.name).toBe("Maria");
    expect(draft.clientId).toBe(4);
  });
  it("rejects empty offers and fractional plan quantities while allowing fractional products", () => {
    const draft = newDraft();
    expect(validateDraft(draft)).toBeTruthy();
    draft.recipient.name = "Maria";
    draft.lines = [
      {
        kind: "plan",
        description: "Plano",
        period: "monthly",
        quantity: 1.5,
        unitPriceCentavos: 100,
      },
    ];
    expect(validateDraft(draft)).toContain("inteira");
    draft.lines[0].kind = "free";
    expect(validateDraft(draft)).toBeNull();
  });
});

describe('proforma request', () => {
  test('parses CVE exactly and rejects rounding or scientific notation', async () => {
    const {parsePaymentAmount} = await import('./draft');
    expect(parsePaymentAmount('1234,56')).toBe(123456);
    expect(parsePaymentAmount('0.01')).toBe(1);
    for (const value of ['1.001','1e3','-1','0','', '1000000000.01']) expect(parsePaymentAmount(value)).toBeNull();
  });
  test('requires complete instructions and allows multiple months', () => {
    const draft = newDraft(); draft.recipient.name = 'Maria';
    draft.lines = [{kind:'free', description:'Internet', period:'monthly', quantity:1, unitPriceCentavos:250000}];
    draft.documentType = 'proforma';
    expect(validateDraft(draft)).not.toBeNull();
    draft.paymentRequest = {amountCentavos:3000000, description:'Doze mensalidades', conditions:'Transferência', dueDate:null};
    expect(validateDraft(draft)).toBeNull();
  });
});

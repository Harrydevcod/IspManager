import { describe, expect, it } from "vitest";
import {
  actionPayload,
  draftFromProposal,
  newDraft,
  planLines,
  productLine,
  proposalTotals,
  validateDraft,
} from "./draft";
import type { Proposal } from "../../../shared/proposals";

describe("proposal composition", () => {
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
        Number.isFinite(Date.parse(delivery.deliveredAt)),
    ).toBe(true);
  });
  it("projects stored and revised drafts into editable DTOs without database fields", () => {
    const proposal: Proposal = {
      ...newDraft(),
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
      JSON.stringify({ ...draft, version: proposal.version }),
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

/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalsModule } from "./ProposalsModule";
import { sectionIdsForRole } from "../../App";

const mocks = vi.hoisted(() => ({ role: "operator", fetch: vi.fn() }));
vi.mock("../../lib/auth", () => ({
  authFetch: mocks.fetch,
  useAuth: () => ({
    isAuthBypassed: false,
    hasRole: (...roles: string[]) => roles.includes(mocks.role),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
let root: Root;
let host: HTMLDivElement;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  mocks.role = "operator";
  mocks.fetch.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ error: "Stale version" }, 409);
    if (url.endsWith("/clients"))
      return json([
        { id: 1, fullName: "Maria", clientCode: "C001", phone: "9911111" },
        { id: 2, fullName: "Indiferenciado", systemKind: "indifferentiated" },
      ]);
    if (url.endsWith("/plans"))
      return json([
        {
          id: 1,
          name: "Fibra 100",
          active: 1,
          monthlyPriceCve: 2500,
          installationFeeCve: 0,
        },
      ]);
    if (url.endsWith("/equipment-catalog")) return json([]);
    return json({ items: [], total: 0, page: 1, pageSize: 25 });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(<ProposalsModule />);
  });
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function select(label: string, value: string) {
  const el = [...host.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("select")!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
describe("commercial proposal workspace", () => {
  it("denies technicians in the module and navigation without fetching offers", async () => {
    mocks.role = "technician";
    await render();
    expect(host.textContent).toContain("Sem acesso");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(sectionIdsForRole("technician")).not.toContain("proposals");
    expect(sectionIdsForRole("operator")).toContain("proposals");
    expect(sectionIdsForRole("admin")).toContain("proposals");
  });
  it("composes free installation and monthly plan, excluding system recipients, and retains edits after conflict", async () => {
    await render();
    await click("Nova proposta");
    expect(host.textContent).not.toContain("Indiferenciado");
    await select("Cliente existente ou interessado", "1");
    await select("Acrescentar plano", "1");
    expect(host.textContent).toContain("Total de custos únicos");
    expect(host.textContent).toContain("Total mensal");
    expect(host.querySelector("form")!.checkValidity()).toBe(true);
    await click("Guardar rascunho");
    const call = mocks.fetch.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body.recipient.name).toBe("Maria");
    expect(body.lines.map((l: { period: string }) => l.period)).toEqual([
      "monthly",
      "once",
    ]);
    expect(body.lines[1].unitPriceCentavos).toBe(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Stale version",
    );
    const values = [...host.querySelectorAll("input")].map((i) => i.value);
    expect(values).toContain("Maria");
    expect(values).toContain("Fibra 100");
  });
});

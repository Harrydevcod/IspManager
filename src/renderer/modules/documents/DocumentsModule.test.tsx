/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentsModule } from "./DocumentsModule";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), allowed: true }));
vi.mock("../../lib/auth", () => ({
  authFetch: mocks.fetch,
  useAuth: () => ({ hasRole: () => mocks.allowed, isAuthBypassed: false }),
}));
vi.mock("../proposals/ProposalsModule", () => ({
  ProposalsModule: () => <p>Ofertas</p>,
}));
vi.mock("../payments/ManualInvoiceDialog", () => ({
  ManualInvoiceDialog: ({ open }: { open: boolean }) =>
    open ? <p>Formulário de fatura</p> : null,
}));
vi.mock("../payments/SaleTicketDialog", () => ({
  SaleTicketDialog: () => null,
}));
vi.mock("../payments/SaleTicketDetailDialog", () => ({
  SaleTicketDetailDialog: () => null,
}));
vi.mock("../../lib/download", () => ({
  useAuthenticatedObjectUrl: () => ({ objectUrl: null, error: false }),
  downloadAuthenticated: vi.fn(),
  printAuthenticated: vi.fn(),
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  mocks.allowed = true;
});
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<DocumentsModule onOpenPayment={vi.fn()} />),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
test("starts in informatives and exposes fiscal creation with all periods", async () => {
  mocks.fetch.mockClear();
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/clients")
            ? []
            : { items: [], total: 0, page: 1, pageSize: 25 },
        ),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await render();
  expect(host.textContent).toContain("Ofertas");
  await click("Fiscais");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  const fiscalCall = mocks.fetch.mock.calls.find(([url]) =>
    url.includes("/documents/fiscal?"),
  );
  expect(fiscalCall).toBeTruthy();
  expect(fiscalCall![0]).not.toContain("from=");
  await click("Nova fatura");
  expect(host.textContent).toContain("Formulário de fatura");
});
test("denies access without fetching", async () => {
  mocks.fetch.mockClear();
  mocks.allowed = false;
  await render();
  expect(host.textContent).toContain("Sem acesso");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

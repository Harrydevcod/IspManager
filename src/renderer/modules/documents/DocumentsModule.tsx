import { useEffect, useState } from "react";
import { Button } from "../../components";
import { useAuth } from "../../lib/auth";
import type { Client } from "../../types";
import { ProposalsModule } from "../proposals/ProposalsModule";
import { FiscalDocuments } from "./FiscalDocuments";
import "./DocumentsModule.css";
export function DocumentsModule({
  initialClient,
  onInitialClientHandled,
  onOpenPayment,
}: {
  initialClient?: Client | null;
  onInitialClientHandled?: () => void;
  onOpenPayment: (id: number) => void;
}) {
  const { hasRole, isAuthBypassed } = useAuth();
  const [tab, setTab] = useState<"informative" | "fiscal">("informative");
  useEffect(() => {
    if (initialClient) setTab("informative");
  }, [initialClient]);
  if (!isAuthBypassed && !hasRole("admin", "operator"))
    return <p role="alert">Sem acesso aos documentos.</p>;
  return (
    <section className="documents-shell" aria-label="Documentos">
      <div className="documents-navigation">
        <p className="eyebrow">Documentos</p>
        <nav
          className="segmented-tabs"
          role="tablist"
          aria-label="Categoria de documentos"
        >
          <Button
            variant="ghost"
            role="tab"
            id="informative-tab"
            aria-controls="informative-panel"
            aria-selected={tab === "informative"}
            className={`segmented-tab${tab === "informative" ? " is-active" : ""}`}
            onClick={() => setTab("informative")}
          >
            Informativos
          </Button>
          <Button
            variant="ghost"
            role="tab"
            id="fiscal-tab"
            aria-controls="fiscal-panel"
            aria-selected={tab === "fiscal"}
            className={`segmented-tab${tab === "fiscal" ? " is-active" : ""}`}
            onClick={() => setTab("fiscal")}
          >
            Fiscais
          </Button>
        </nav>
      </div>
      <div
        role="tabpanel"
        id="informative-panel"
        aria-labelledby="informative-tab"
        hidden={tab !== "informative"}
      >
        <ProposalsModule
          initialClient={initialClient}
          onInitialClientHandled={onInitialClientHandled}
        />
      </div>
      <div
        role="tabpanel"
        id="fiscal-panel"
        aria-labelledby="fiscal-tab"
        hidden={tab !== "fiscal"}
      >
        <FiscalDocuments
          active={tab === "fiscal"}
          onOpenPayment={onOpenPayment}
        />
      </div>
    </section>
  );
}

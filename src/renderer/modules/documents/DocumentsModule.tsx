import { useEffect, useState } from "react";
import { TabList } from "../../components";
import { useAuth } from "../../lib/auth";
import type { Client } from "../../types";
import { ProposalsModule } from "../proposals/ProposalsModule";
import { FiscalDocuments } from "./FiscalDocuments";
import "./DocumentsModule.css";

const DOCUMENT_TABS = [
  { id: "informative", label: "Informativos" },
  { id: "fiscal", label: "Fiscais" },
] as const;

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
        <TabList
          segmented
          idPrefix="documents"
          label="Categoria de documentos"
          tabs={DOCUMENT_TABS}
          value={tab}
          onChange={setTab}
        />
      </div>
      <div
        role="tabpanel"
        id="documents-panel-informative"
        aria-labelledby="documents-tab-informative"
        hidden={tab !== "informative"}
      >
        <ProposalsModule
          initialClient={initialClient}
          onInitialClientHandled={onInitialClientHandled}
        />
      </div>
      <div
        role="tabpanel"
        id="documents-panel-fiscal"
        aria-labelledby="documents-tab-fiscal"
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

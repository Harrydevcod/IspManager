import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Combobox, Dialog, Message, Toggle, useToast } from '../../../components';
import { sameModel } from '../../../../shared/model-match';
import { createBackboneApi, type BackboneCatalogOption } from '../backbone-api';
import type { DiscoveryRow } from './discovery-api';

/**
 * Registar de uma vez vários equipamentos que a rede encontrou.
 *
 * **Só entram os que responderam um modelo.** Um fabricante sozinho não chega:
 * numa varredura desta rede a maioria dos desconhecidos são telemóveis e
 * portáteis — 41 dos 82 nem fabricante têm, porque usam MAC aleatório. Listá-los
 * aqui era convidar a encher o inventário de equipamento que não é nosso.
 *
 * Serve um arranque ou uma instalação de várias antenas do mesmo modelo. Para
 * um equipamento só, o "Registar como backbone" da linha é mais direto.
 */

export type BatchRegisterDialogProps = {
  open: boolean;
  rows: DiscoveryRow[];
  onClose: () => void;
  onRegistered: () => void;
};

const api = createBackboneApi();

/** Um nome que se percebe sem abrir nada: o que o aparelho disse, ou o modelo. */
function suggestName(row: DiscoveryRow): string {
  return row.hostname?.trim() || `${row.probedModel ?? row.model ?? 'Equipamento'} ${row.ip}`;
}

export function candidatesFor(rows: DiscoveryRow[]): DiscoveryRow[] {
  return rows.filter((row) => row.category === 'desconhecido' && row.alive && (row.probedModel ?? row.model));
}

export function BatchRegisterDialog({ open, rows, onClose, onRegistered }: BatchRegisterDialogProps) {
  const candidates = useMemo(() => candidatesFor(rows), [rows]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [catalogId, setCatalogId] = useState<number | null>(null);
  const [catalogs, setCatalogs] = useState<BackboneCatalogOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setPicked(new Set(candidates.map((row) => row.ip)));
    setFailures([]);
    void api.listCatalogs().then(setCatalogs).catch(() => setCatalogs([]));
  }, [open, candidates]);

  // Todos do mesmo modelo? Então o item do catálogo escolhe-se sozinho. Modelos
  // misturados ficam por escolher de propósito — um lote com dois modelos
  // registados como um só é pior do que um lote por registar.
  useEffect(() => {
    const models = new Set(candidates.map((row) => row.probedModel ?? row.model));
    if (models.size !== 1 || catalogs.length === 0) return;
    const [model] = [...models];
    const hits = catalogs.filter((item) => sameModel([item.brand, item.model].filter(Boolean).join(' '), model!));
    if (hits.length === 1) setCatalogId(hits[0].id);
  }, [candidates, catalogs]);

  const chosen = candidates.filter((row) => picked.has(row.ip));

  function toggle(ip: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  }

  async function submit() {
    if (!catalogId || chosen.length === 0) return;
    setBusy(true);
    setFailures([]);
    const failed: string[] = [];

    // Um a um, e um erro não trava os outros: um MAC repetido num equipamento
    // não é motivo para deitar fora o registo dos restantes.
    for (const row of chosen) {
      try {
        await api.createBackbone({
          catalogId,
          name: suggestName(row),
          status: 'active',
          serialNumber: null,
          assetTag: null,
          ipAddress: row.ip,
          macAddress: row.mac,
          island: null,
          zone: null,
          notes: null,
          upstreamDeviceIds: []
        });
      } catch (err) {
        failed.push(`${row.ip}: ${err instanceof Error ? err.message : 'falhou'}`);
      }
    }

    setBusy(false);
    setFailures(failed);
    const done = chosen.length - failed.length;
    if (done > 0) {
      toast(done === 1 ? '1 equipamento registado' : `${done} equipamentos registados`, 'success');
      onRegistered();
    }
    if (failed.length === 0) onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Descoberta"
      title="Registar equipamento encontrado"
      size="lg"
      closeOnBackdrop={!busy}
      actions={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button loading={busy} disabled={!catalogId || chosen.length === 0} onClick={() => void submit()}>
            {chosen.length === 1 ? 'Registar 1' : `Registar ${chosen.length}`}
          </Button>
        </>
      )}
    >
      {candidates.length === 0 ? (
        <Message tone="neutral">
          Nenhum desconhecido respondeu um modelo. Sem modelo não há como saber que equipamento é —
          e o que não diz o que é raramente é nosso.
        </Message>
      ) : (
        <div className="batch-register">
          <div className="field">
            <span className="field-label">Equipamento do catálogo</span>
            <Combobox
              ariaLabel="Equipamento do catálogo"
              options={catalogs}
              value={catalogId}
              onChange={(value) => setCatalogId(typeof value === 'number' ? value : null)}
              rowKey={(row) => row.id}
              rowCode={(row) => row.brand || 'Sem marca'}
              rowLabel={(row) => row.model}
              rowHint={(row) => row.type}
              searchPlaceholder="Pesquisar marca ou modelo"
            />
            <span className="field-hint">Vale para todos os selecionados.</span>
          </div>

          <div className="batch-register-list">
            {candidates.map((row) => (
              <Toggle
                key={row.ip}
                title={`${row.ip} · ${row.probedModel ?? row.model}`}
                description={`Fica registado como "${suggestName(row)}"`}
                checked={picked.has(row.ip)}
                disabled={busy}
                onChange={() => toggle(row.ip)}
              />
            ))}
          </div>

          {failures.length > 0 ? (
            <Message tone="error">
              <AlertTriangle size={14} aria-hidden /> {failures.join(' · ')}
            </Message>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

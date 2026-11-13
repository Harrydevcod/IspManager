import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Select, useToast } from '../../components';
import { authFetch } from '../../lib/auth';
import type { BackboneAssignmentSummary, BackbonePage } from '../../../shared/backbone';

const API = 'http://127.0.0.1:3001/api';
const NEW_DEVICE = 'new';

type ServiceOption = { id: number; clientCode: string; clientName: string; planName: string | null; status: string };

type MoveToClientDialogProps = {
  device: { id: number; name: string; catalogType: string };
  onClose: () => void;
  onMoved: () => void;
};

/** CPE de cliente registado por engano como backbone: passa para o serviço do cliente. */
export function MoveToClientDialog({ device, onClose, onMoved }: MoveToClientDialogProps) {
  const { toast } = useToast();
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [search, setSearch] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [assignments, setAssignments] = useState<BackboneAssignmentSummary[]>([]);
  const [target, setTarget] = useState(NEW_DEVICE);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void authFetch(`${API}/services`)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: ServiceOption[]) => setServices(rows.filter((s) => s.status !== 'cancelled')))
      .catch(() => setServices([]));
  }, []);

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return services;
    return services.filter((s) => `${s.clientName} ${s.clientCode}`.toLowerCase().includes(term));
  }, [services, search]);

  const service = services.find((s) => String(s.id) === serviceId);

  // O mesmo aparelho já na ficha: só as atribuições ativas deste serviço e do mesmo tipo.
  useEffect(() => {
    setTarget(NEW_DEVICE);
    setAssignments([]);
    if (!service) return;
    void authFetch(`${API}/topology/assignments?query=${encodeURIComponent(service.clientCode)}&pageSize=100`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((page: BackbonePage<BackboneAssignmentSummary>) => {
        const sameType = page.items.filter((a) => a.serviceId === service.id && a.catalogType === device.catalogType);
        setAssignments(sameType);
        if (sameType.length === 1) setTarget(String(sameType[0].id));
      })
      .catch(() => setAssignments([]));
  }, [service, device.catalogType]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!service) return;
    setSubmitting(true);
    try {
      const response = await authFetch(`${API}/topology/backbones/${device.id}/move-to-client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: service.id, assignmentId: target === NEW_DEVICE ? null : Number(target) })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        toast(body.error || 'Não foi possível passar o equipamento para o cliente.', 'error');
        return;
      }
      toast(`${device.name} passou para ${service.clientName}.`, 'success');
      onMoved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      title={`Passar ${device.name} para cliente`}
      onClose={onClose}
      eyebrow="Topologia"
      actions={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="move-to-client-form" loading={submitting} disabled={!service}>Passar para cliente</Button>
        </>
      )}
    >
      <form id="move-to-client-form" className="move-to-client-form" onSubmit={submit}>
        <Field label="Procurar cliente" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <Select label="Serviço" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required>
          <option value="">Escolher…</option>
          {matches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.clientName} · {s.clientCode}{s.planName ? ` · ${s.planName}` : ''}
            </option>
          ))}
        </Select>
        {service && (
          <Select label="Equipamento na ficha" value={target} onChange={(e) => setTarget(e.target.value)}>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {/* A identidade primeiro: o nome do modelo é longo e o select corta o fim. */}
                {a.macAddress || a.serialNumber || `#${a.id}`} · {[a.catalogBrand, a.catalogModel].filter(Boolean).join(' ')}
              </option>
            ))}
            <option value={NEW_DEVICE}>Instalar como novo</option>
          </Select>
        )}
      </form>
    </Dialog>
  );
}

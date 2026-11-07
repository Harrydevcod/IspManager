import { useEffect, useRef, useState } from 'react';
import { ScanSearch, Tv } from 'lucide-react';
import { parseCidr } from '../../../shared/ip-range';
import { Badge, Button, Field, Message, Select, Toggle } from '../../components';
import {
  IPTV_API, describeSource, describeValidation, iptvRequest,
  type IptvProvider, type IptvStatus, type IptvTarget, type IptvValidateResult, type IptvValidation
} from '../iptv/iptv-api';
import { SourceText } from '../iptv/SourceText';
import type { DeviceAssignment, ServiceRow } from '../../types';

/**
 * A gama LAN de um router de cliente (0089). Só o router tem uma LAN que possa colidir
 * com as gamas do ISP, por isso o campo só aparece para ele.
 */
export function LanCidrField({ catalogType, value, onChange }: { catalogType: string | null | undefined; value: string; onChange: (value: string) => void }) {
  if ((catalogType ?? '').trim().toLowerCase() !== 'router') return null;
  const invalid = value.trim() !== '' && !parseCidr(value);
  return (
    <Field
      label="Gama LAN"
      value={value}
      placeholder="192.168.0.0/24"
      onChange={(event) => onChange(event.target.value)}
      error={invalid ? 'Use rede/prefixo, ex.: 192.168.0.0/24' : undefined}
    />
  );
}

type IptvSectionProps = {
  service: ServiceRow;
  canManage: boolean;
  /** A marca mudou: recarregar a lista de serviços. */
  onChanged: () => void;
  assignments?: readonly DeviceAssignment[];
};

/**
 * IPTV na ficha do serviço (ADR 0021). O serviço diz que tem IPTV e de que fornecedor;
 * o caminho é do fornecedor: precisa de VPN → túnel, senão pelas WAN (0099). A origem
 * vem da base, sem tocar no router; só "Validar no router" o lê, e só a pedido.
 */
export function IptvSection({ service, canManage, onChanged, assignments }: IptvSectionProps) {
  const marked = Boolean(service.iptvVpn);
  const [providers, setProviders] = useState<IptvProvider[]>([]);
  // Sem fornecedor (ou ainda por carregar) vai pelo túnel, como o backend em `loadIptvTargets`.
  const provider = providers.find((p) => p.id === service.iptvProviderId);
  const viaTunnel = marked && provider?.needsVpn !== 0;
  const [target, setTarget] = useState<IptvTarget | null>(null);
  const [validation, setValidation] = useState<IptvValidation | null>(null);
  const [collisions, setCollisions] = useState<IptvValidateResult['lanCollisions']>([]);
  const [busy, setBusy] = useState<'save' | 'validate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validationRevision = useRef(0);

  useEffect(() => {
    let alive = true;
    iptvRequest<IptvProvider[]>(`${IPTV_API}/providers`)
      .then((rows) => { if (alive) setProviders(rows); })
      .catch(() => { /* sem fornecedores, o seletor fica só com "Nenhum" */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    validationRevision.current += 1;
    setBusy((current) => current === 'validate' ? null : current);
    setValidation(null);
    setCollisions([]);
    setError(null);
    setTarget(null);
    if (!viaTunnel) { setTarget(null); return; }
    iptvRequest<IptvStatus>(`${IPTV_API}/status`)
      .then((status) => { if (alive) setTarget(status.targets.find((row) => row.serviceId === service.id) ?? null); })
      .catch((failure: Error) => { if (alive) setError(failure.message); });
    return () => { alive = false; validationRevision.current += 1; };
  }, [viaTunnel, service.id, service.iptvProviderId, service.status, service.pppoeUsername, assignments]);

  const save = async (iptvVpn: boolean, iptvProviderId: number | null) => {
    setBusy('save');
    setError(null);
    try {
      await iptvRequest(`http://127.0.0.1:3001/api/services/${service.id}/iptv`, { method: 'PUT', body: { iptvVpn, iptvProviderId } });
      onChanged();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    const revision = ++validationRevision.current;
    setBusy('validate');
    setError(null);
    setValidation(null);
    setCollisions([]);
    try {
      const result = await iptvRequest<IptvValidateResult>(`${IPTV_API}/validate`);
      if (revision !== validationRevision.current) return;
      setValidation(result.services.find((row) => row.serviceId === service.id)?.validation ?? null);
      setCollisions(result.lanCollisions.filter((row) => row.serviceId === service.id));
    } catch (failure) {
      if (revision === validationRevision.current) setError((failure as Error).message);
    } finally {
      if (revision === validationRevision.current) setBusy(null);
    }
  };

  // Todos os ativos, com e sem VPN; um desativado continua a aparecer enquanto for o deste serviço.
  const options = providers.filter((p) => p.active === 1 || p.id === service.iptvProviderId);
  // Só o nome: se precisa de VPN decide-se na gestão dos fornecedores; o caminho vê-se na etiqueta.
  const optionLabel = (p: IptvProvider) => p.active !== 1 ? `${p.name} (desativado)` : p.name;
  const source = target ? describeSource(target.source) : null;
  const seen = validation ? describeValidation(validation) : null;

  return (
    <section className="technical-section">
      <header className="technical-section-head">
        <div>
          <p className="eyebrow"><Tv size={12} /> IPTV</p>
          <h3>
            {!marked
              ? <Badge tone="neutral">Sem IPTV</Badge>
              : viaTunnel ? <Badge tone="accent">Pelo túnel VPN</Badge> : <Badge tone="neutral">Pelas WAN</Badge>}
          </h3>
        </div>
      </header>

      <div className="iptv-controls">
        <Toggle
          wide={false}
          title="IPTV"
          checked={marked}
          disabled={!canManage || busy !== null}
          onChange={(event) => void save(event.target.checked, event.target.checked ? service.iptvProviderId ?? null : null)}
        />
        {marked && (
          <Select
            label="Fornecedor de IPTV"
            value={service.iptvProviderId ?? ''}
            disabled={!canManage || busy !== null}
            onChange={(event) => void save(true, event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">Nenhum</option>
            {options.map((p) => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}
          </Select>
        )}
      </div>

      {viaTunnel && (
        <dl className="technical-item-meta">
          <div>
            <dt>Origem no router</dt>
            <dd>
              {service.status !== 'active'
                ? 'Serviço inativo'
                : source
                  ? <SourceText source={source} />
                  : 'A ler…'}
            </dd>
          </div>
          {seen && (
            <div>
              <dt>No router</dt>
              <dd><Badge tone={seen.tone}>{seen.label}</Badge>{seen.detail && <> {seen.detail}</>}</dd>
            </div>
          )}
        </dl>
      )}

      {collisions.map((collision) => <Message key={`${collision.assignmentId}-${collision.collidesWith}`} tone="warn">A gama LAN {collision.lanCidr} do equipamento {collision.assignmentId} colide com a gama do ISP {collision.collidesWith}. Altere a gama LAN do cliente.</Message>)}
      {error && <Message tone="error">{error}</Message>}

      {viaTunnel && canManage && service.status === 'active' && (
        <div className="technical-item-actions">
          <Button variant="secondary" size="sm" disabled={busy !== null} leadingIcon={<ScanSearch size={14} aria-hidden />} onClick={() => void validate()}>
            {busy === 'validate' ? 'A validar…' : 'Validar no router'}
          </Button>
        </div>
      )}
    </section>
  );
}

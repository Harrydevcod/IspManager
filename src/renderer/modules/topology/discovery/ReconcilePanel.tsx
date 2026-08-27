import { useMemo, useState } from 'react';
import { ArrowRight, Check, EyeOff, Wrench } from 'lucide-react';
import { Badge, Button, EmptyState, useToast } from '../../../components';
import type { DiscoveryApi, Orphan, Proposal, ProposalKind, Reconciliation } from './discovery-api';

/**
 * O que a rede sabe e o registo ainda não.
 *
 * Nada aqui escreve sozinho. Cada linha diz o que está e o que passaria a
 * estar, e espera por um botão — é a mesma disciplina do
 * `fill-macs-from-discovery.cjs`, que simula por omissão e só escreve com
 * `--apply`. Uma ferramenta que corrige a base de dados a partir de pings sem
 * ninguém confirmar seria a forma mais rápida de deixar de se poder confiar no
 * registo.
 */

type Group = {
  kind: ProposalKind;
  title: string;
  /** Uma frase que explica **porquê**, não o que já se vê na linha. */
  hint: string;
  applies: boolean;
};

const GROUPS: Group[] = [
  {
    kind: 'mac_em_falta',
    title: 'MAC por preencher',
    hint: 'O equipamento respondeu neste endereço e o registo não tem o MAC dele. É o MAC que o torna reconhecível quando o endereço mudar.',
    applies: true
  },
  {
    kind: 'ip_mudou',
    title: 'Endereço diferente',
    hint: 'O mesmo aparelho — foi reconhecido pelo MAC — está noutro endereço. Acontece com quem apanha IP por DHCP e foi desligado.',
    applies: true
  },
  {
    kind: 'ip_em_falta',
    title: 'Endereço por preencher',
    hint: 'Reconhecido pelo MAC, mas sem endereço no registo.',
    applies: true
  },
  {
    kind: 'modelo_diferente',
    title: 'Modelo diferente do registado',
    hint: 'O aparelho na rede não é o que está registado. Não se corrige aqui: trocar o item do catálogo é mexer no stock, e o caminho certo é registar a troca de equipamento em Serviços.',
    applies: false
  },
  {
    kind: 'backbone_ausente',
    title: 'Backbone sem resposta',
    hint: 'Ativo no registo, mas há dias que não responde. Passar a manutenção faz-se no separador Backbone.',
    applies: false
  }
];

const KIND_LABEL: Record<ProposalKind, string> = {
  mac_em_falta: 'MAC',
  ip_em_falta: 'endereço',
  ip_mudou: 'endereço',
  modelo_diferente: 'modelo',
  backbone_ausente: 'estado'
};

export type ReconcilePanelProps = {
  data: Reconciliation | null;
  api: DiscoveryApi;
  onChanged: () => void;
};

export function ReconcilePanel({ data, api, onChanged }: ReconcilePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  const byKind = useMemo(() => {
    const map = new Map<ProposalKind, Proposal[]>();
    for (const proposal of data?.proposals ?? []) {
      map.set(proposal.kind, [...(map.get(proposal.kind) ?? []), proposal]);
    }
    return map;
  }, [data]);

  const orphans = (data?.orphans ?? []).filter((orphan) => orphan.candidates.length > 0);
  const total = data?.proposals.length ?? 0;

  // Sem nada a propor não se mostra um painel vazio a ocupar ecrã — a ausência
  // de propostas é a boa notícia, não precisa de moldura.
  if (total === 0 && orphans.length === 0) return null;

  const key = (proposal: Proposal) => `${proposal.kind}:${proposal.targetKind}:${proposal.targetId}`;

  async function apply(proposal: Proposal) {
    if (proposal.targetKind !== 'assignment') return;
    setBusy(key(proposal));
    try {
      const patch = proposal.kind === 'mac_em_falta'
        ? { macAddress: proposal.proposed }
        : { ipAddress: proposal.proposed };
      await api.patchAssignment(proposal.targetId, patch);
      toast(`${KIND_LABEL[proposal.kind]} de ${proposal.name} atualizado`, 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível aplicar', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(proposal: Proposal) {
    setBusy(key(proposal));
    try {
      await api.dismissProposal(proposal.kind, proposal.targetKind, proposal.targetId);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Não foi possível dispensar', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="reconcile" aria-label="Aplicar ao registo">
      <header className="reconcile-head">
        <h3>Aplicar ao registo</h3>
        <Badge tone={total > 0 ? 'warn' : 'neutral'}>
          {total === 1 ? '1 diferença' : `${total} diferenças`}
        </Badge>
      </header>

      {GROUPS.map((group) => {
        const proposals = byKind.get(group.kind) ?? [];
        if (proposals.length === 0) return null;

        return (
          <div className="reconcile-group" key={group.kind}>
            <div className="reconcile-group-head">
              <strong>{group.title}</strong>
              <span className="reconcile-hint">{group.hint}</span>
            </div>

            {proposals.map((proposal) => (
              <div className="reconcile-row" key={key(proposal)}>
                <span className="reconcile-who">{proposal.name}</span>
                <code className="reconcile-ip">{proposal.ip}</code>
                {/* O antes e o depois lado a lado: mostrar só o valor novo
                    obriga a ir procurar o antigo noutro ecrã para decidir. */}
                <span className="reconcile-change">
                  <span className="reconcile-before">{proposal.current ?? '—'}</span>
                  <ArrowRight size={14} aria-hidden />
                  <span className="reconcile-after">{proposal.proposed}</span>
                </span>
                <span className="reconcile-actions">
                  {group.applies ? (
                    <Button
                      size="sm"
                      leadingIcon={<Check size={14} aria-hidden />}
                      loading={busy === key(proposal)}
                      onClick={() => void apply(proposal)}
                    >
                      Aplicar
                    </Button>
                  ) : (
                    <Badge tone="neutral">
                      <Wrench size={12} aria-hidden /> em Serviços
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<EyeOff size={14} aria-hidden />}
                    disabled={busy === key(proposal)}
                    onClick={() => void dismiss(proposal)}
                  >
                    Dispensar
                  </Button>
                </span>
              </div>
            ))}
          </div>
        );
      })}

      {orphans.length > 0 ? <OrphanGroup orphans={orphans} /> : null}
    </section>
  );
}

/**
 * Equipamento registado sem endereço nem MAC — a rede não tem por onde o
 * reconhecer.
 *
 * A lista de candidatos é **para escolher, não é uma resposta**: com vinte
 * routers da mesma marca no parque não há par único, e apontar um seria
 * inventar. O que se pode fazer é reduzir a escolha ao fabricante certo.
 */
function OrphanGroup({ orphans }: { orphans: Orphan[] }) {
  return (
    <div className="reconcile-group">
      <div className="reconcile-group-head">
        <strong>Sem identidade na rede</strong>
        <span className="reconcile-hint">
          Registado sem endereço nem MAC. Os candidatos são os desconhecidos do mesmo fabricante —
          uma lista para escolher, não uma resposta.
        </span>
      </div>
      {orphans.map((orphan) => (
        <div className="reconcile-row is-orphan" key={`${orphan.targetKind}:${orphan.targetId}`}>
          <span className="reconcile-who">{orphan.name}</span>
          {/* O catálogo guarda descrições comerciais compridas no campo do
              modelo; numa linha de lista isso empurra tudo para baixo. Fica
              numa linha só, com o texto inteiro na dica. */}
          <span className="reconcile-model" title={orphan.model ?? undefined}>{orphan.model ?? '—'}</span>
          <span className="reconcile-candidates">
            {orphan.candidates.map((candidate) => (
              <code className="reconcile-ip" key={candidate.ip} title={candidate.vendor ?? undefined}>
                {candidate.ip}
              </code>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReconcileEmpty() {
  return (
    <EmptyState
      icon={Check}
      title="O registo bate certo com a rede"
      description="Nada a aplicar. Varra outra vez depois de instalar ou trocar equipamento."
    />
  );
}

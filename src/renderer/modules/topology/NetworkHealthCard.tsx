import { useState } from 'react';
import { AlertTriangle, NotebookPen, RadioTower, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorRetry, Skeleton } from '../../components';
import { useAuth } from '../../lib/auth';
import { formatPtDateTime } from '../../lib/format';
import { useLive } from '../router/useLive';
import { NetworkDiaryDialog } from './NetworkDiaryDialog';
import { antennaDrops, healthSituations, NETWORK_API, TONE_LABEL, type NetworkHealth } from './network-health';

/**
 * A rede no painel inicial: o que a sonda e o registo do router viram nas últimas 72 horas.
 * Pede por conta própria, para não atrasar o resto do painel.
 */
export function NetworkHealthCard({ onOpenNetwork }: { onOpenNetwork: () => void }) {
  const live = useLive<NetworkHealth>(`${NETWORK_API}/health`, true, 60_000);
  const { user } = useAuth();
  const canWrite = !user || ['admin', 'operator'].includes(user.role);
  const [registering, setRegistering] = useState(false);
  // Uma resposta que não é a saúde da rede (um backend antigo na mesma porta) não pode deitar
  // o painel inteiro abaixo: trata-se como leitura falhada.
  const health = live.data && Array.isArray(live.data.findings) && Array.isArray(live.data.diary) ? live.data : null;
  const unreadable = Boolean(live.error) || (live.data !== null && !health);
  const situations = health ? healthSituations(health) : [];
  const openDiary = health?.diary.filter((entry) => entry.status === 'aberta').length ?? 0;

  return (
    <Card eyebrow={`Últimas ${health?.hours ?? 72} horas`} title="Saúde da rede" className="dashboard-card-list network-health-card"
      actions={health ? <Badge tone={TONE_LABEL[health.tone].badge}>{TONE_LABEL[health.tone].label}</Badge> : undefined}>
      {unreadable && !health && <ErrorRetry message="Não foi possível ler a saúde da rede." onRetry={live.reload} />}
      {!unreadable && !health && <Skeleton height={180} radius={12} />}
      {health && (
        <>
          <dl className="network-health-figures">
            <div data-alert={antennaDrops(health) > 0 ? 'warning' : undefined}>
              <dt>Quedas de antenas</dt>
              <dd>{antennaDrops(health)}</dd>
            </div>
            <div data-alert={health.downNow.length > 0 ? 'danger' : undefined}>
              <dt>Em baixo agora</dt>
              <dd>{health.downNow.length}</dd>
            </div>
            <div>
              <dt>Ocorrências abertas</dt>
              <dd>{openDiary}</dd>
            </div>
          </dl>

          {situations.length > 0 ? (
            <ul className="dashboard-list dashboard-list-queue">
              {situations.slice(0, 3).map((situation) => (
                <li key={situation.key}>
                  {situation.tone === 'neutral' ? <RadioTower size={14} /> : <AlertTriangle size={14} />}
                  <div className="dashboard-list-meta">
                    <strong>{situation.title}</strong>
                    <small>{situation.detail}</small>
                  </div>
                  {situation.count !== null && (
                    <Badge tone={situation.tone === 'neutral' ? 'neutral' : situation.tone === 'warn' ? 'warn' : 'danger'}>{situation.count}×</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="sm" icon={ShieldCheck} title="Sem nada a assinalar"
              description={health.probeEnabled ? 'Nenhuma queda nem achado do router na janela.' : 'A sonda de rede está desligada; ligue-a em Definições.'} />
          )}

          {/* Só se vê o que aconteceu com o ISPM aberto: dizer até onde se viu. */}
          <p className="network-health-seen">
            Sonda: {health.lastProbeAt ? formatPtDateTime(health.lastProbeAt) : 'sem leituras'}
            {' · '}
            Router: {health.lastRouterReadAt ? formatPtDateTime(health.lastRouterReadAt) : 'por ler'}
          </p>

          <div className="dashboard-card-footer">
            {canWrite && (
              <Button variant="ghost" leadingIcon={<NotebookPen size={14} aria-hidden />} onClick={() => setRegistering(true)}>
                Registar ocorrência
              </Button>
            )}
            <Button variant="secondary" className="dashboard-cta" leadingIcon={<RadioTower size={14} aria-hidden />} onClick={onOpenNetwork}>
              Ver detalhe{situations.length > 3 ? ` (${situations.length})` : ''}
            </Button>
          </div>
        </>
      )}
      <NetworkDiaryDialog open={registering} onClose={() => setRegistering(false)}
        onSaved={() => { setRegistering(false); live.reload(); }} />
    </Card>
  );
}

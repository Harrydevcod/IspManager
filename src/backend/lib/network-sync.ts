import { runJob } from './jobRuns';
import { licenseAllowsWrites } from './license';
import { runNetworkEnforcementIfDue } from './network-enforcement';

/**
 * Uma única porta para pôr o router a par da base de dados: o relógio
 * periódico e as gravações (plano, serviço) chamam-na. Pedidos que chegam a
 * meio de uma passagem juntam-se numa só passagem a seguir — duas passagens em
 * paralelo liam o mesmo router e aplicavam a mesma diferença duas vezes.
 */
export function createSyncTrigger(run: () => Promise<unknown>): () => void {
  let running = false;
  let again = false;
  const kick = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    // A falha fica em job_runs (runJob); a passagem seguinte volta a tentar.
    void run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          kick();
        }
      });
  };
  return kick;
}

const trigger = createSyncTrigger(() => runJob('network_enforcement', runNetworkEnforcementIfDue));

/**
 * Pede uma passagem, fora de qualquer transação SQL. Com a integração
 * desligada a passagem sai logo (`runNetworkEnforcementIfDue`); sem licença
 * de escrita, nem começa.
 */
export function requestNetworkSync(): void {
  if (process.env.ISPM_ROUTEROS === 'off' || process.env.VITEST) return;
  if (!licenseAllowsWrites()) return;
  trigger();
}

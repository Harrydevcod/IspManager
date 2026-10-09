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

let queue: Promise<unknown> = Promise.resolve();

/**
 * Fila única das operações que escrevem no router em série: a passagem da
 * reconciliação e a mudança de plano em massa nunca correm ao mesmo tempo.
 */
export function runExclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

const trigger = createSyncTrigger(() => runExclusive(() => runJob('network_enforcement', runNetworkEnforcementIfDue)));

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

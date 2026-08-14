import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getDatabase } from './db/database';
import { registerAuthRoutes } from './routes/auth';
import { registerAuditRoutes } from './routes/audit';
import { registerHealthRoutes } from './routes/health';
import { registerClientRoutes } from './routes/clients';
import { registerUserRoutes } from './routes/users';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerDocumentRoutes } from './routes/documents';
import { registerInvestmentRoutes } from './routes/investments';
import { registerExpenseRoutes } from './routes/expenses';
import { registerExpenseTemplateRoutes } from './routes/expense-templates';
import { runRecurringExpensesIfDue } from './lib/recurring-expenses';
import { registerFinanceRoutes } from './routes/finance';
import { registerPlanRoutes } from './routes/plans';
import { registerReportRoutes } from './routes/reports';
import { registerSettingsRoutes } from './routes/settings';
import { registerTechnicalRoutes } from './routes/technical';
import { registerStockRoutes } from './routes/stock';
import { registerWhatsappRoutes } from './routes/whatsapp';
import { registerSmsRoutes } from './routes/sms';
import { registerWorkOrderRoutes } from './routes/work-orders';
import { registerBackupRoutes } from './routes/backup';
import { registerJobRoutes } from './routes/jobs';
import { licenseGateHook, registerLicenseRoutes } from './routes/license';
import { licenseAllowsWrites } from './lib/license';
import { registerTopologyRoutes } from './routes/topology';
import { registerTopologyManagementRoutes } from './routes/topology-management';
import { createBackup, pruneBackups, runScheduledBackupIfDue } from './lib/backup';
import { runMonthlyBillingIfDue } from './lib/auto-billing';
import { runAudiovisualAnnualIfDue } from './lib/audiovisual-billing';
import { runOverdueNoticesIfDue } from './lib/notices';
import { pollWhatsappDeliveryIfDue, runWhatsappOutboxIfDue } from './lib/whatsapp-outbox';
import { pollSmsStatusIfDue, runSmsOutboxIfDue, smsDispatchIntervalMs } from './lib/sms-outbox';
import { registerNetworkRoutes } from './routes/network';
import { networkProbeIntervalMs, runNetworkProbeIfDue } from './lib/network-probe';
import { runNetworkEnforcementIfDue } from './lib/network-enforcement';
import { routerosIntervalMs } from './lib/routeros';
import { runJob, runJobSync } from './lib/jobRuns';

let serverStarted = false;

export async function createBackendApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'development'
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed =
        !origin ||
        origin === 'http://127.0.0.1:5173' ||
        origin === 'null' ||
        origin.startsWith('file://');
      callback(null, allowed);
    },
    // Content-Disposition nao e CORS-safelisted: sem isto o fetch do renderer nao
    // consegue ler o nome do ficheiro (ex.: "Recibo - Sandra - RC-2026-00077.pdf")
    // e os downloads via blob caem no fallback generico. A app empacotada corre
    // em file://, que o Chromium serializa como origin opaco "null".
    exposedHeaders: ['Content-Disposition']
  });

  // Portão de licenciamento antes de tudo o resto: bloqueia escritas quando a
  // licença não as permite e deixa passar leituras, autenticação e backups.
  // Inerte enquanto não houver chave pública configurada (ver ./lib/license-key).
  app.addHook('onRequest', licenseGateHook());

  getDatabase();

  // One consistent backup per boot. Availability > backup: never block the
  // app if the backup directory is unwritable.
  try {
    await createBackup('startup');
    pruneBackups();
  } catch (err) {
    app.log.error({ err }, 'startup backup failed');
  }

  // Auto-bill the closed month(s) once today >= autoBillingDay (default 30),
  // attributing each invoice to the month it closes and catching up any month
  // missed (desktop app may not open on day 30). Idempotent + opt-out via
  // ISPM_AUTO_BILLING=off (tests).
  // Sem direito de escrita, as tarefas que criam documentos ou contactam
  // clientes ficam paradas — faturar sozinho o que a interface recusa faturar
  // seria incoerente. É seguro parar: `monthsAfter` recupera todos os meses
  // saltados no arranque seguinte à renovação, sem deixar gaps na numeração.
  if (process.env.ISPM_AUTO_BILLING !== 'off' && licenseAllowsWrites()) {
    try {
      const result = runJobSync('auto_billing', runMonthlyBillingIfDue);
      if ('ran' in result) {
        app.log.info({ result }, 'auto billing executed');
      }
    } catch (err) {
      app.log.error({ err }, 'auto billing failed');
    }

    // Anuidade audiovisual: fatura anual separada, gerada/renovada por ciclo.
    // Idempotente; partilha o mesmo opt-out da faturação automática.
    try {
      const result = runJobSync('audiovisual_annual', runAudiovisualAnnualIfDue);
      if ('ran' in result) {
        app.log.info({ result }, 'audiovisual annual billing executed');
      }
    } catch (err) {
      app.log.error({ err }, 'audiovisual annual billing failed');
    }
  }

  // Generate recurring expenses for any due templates. Idempotent.
  if (process.env.ISPM_RECURRING_EXPENSES !== 'off' && licenseAllowsWrites()) {
    try {
      const result = runJobSync('recurring_expenses', runRecurringExpensesIfDue);
      if ('ran' in result) {
        app.log.info({ result }, 'recurring expenses generated');
      }
    } catch (err) {
      app.log.error({ err }, 'recurring expenses failed');
    }
  }

  await registerAuthRoutes(app);
  await registerLicenseRoutes(app);
  await registerAuditRoutes(app);
  await registerUserRoutes(app);
  await registerHealthRoutes(app);
  await registerDashboardRoutes(app);
  await registerClientRoutes(app);
  await registerPlanRoutes(app);
  await registerInvestmentRoutes(app);
  await registerExpenseRoutes(app);
  await registerExpenseTemplateRoutes(app);
  await registerFinanceRoutes(app);
  await registerDocumentRoutes(app);
  await registerTechnicalRoutes(app);
  await registerStockRoutes(app);
  await registerReportRoutes(app);
  await registerSettingsRoutes(app);
  await registerWhatsappRoutes(app);
  await registerSmsRoutes(app);
  await registerWorkOrderRoutes(app);
  await registerBackupRoutes(app);
  await registerJobRoutes(app);
  await registerTopologyRoutes(app);
  await registerTopologyManagementRoutes(app);
  await registerNetworkRoutes(app);

  // Automatic overdue/suspension WhatsApp notices — opt-in via the
  // `autoNoticesEnabled` setting (off by default). Fire-and-forget: the send
  // loop is rate-limited and must never block server boot.
  if (process.env.ISPM_AUTO_NOTICES !== 'off' && licenseAllowsWrites()) {
    void runJob('overdue_notices', runOverdueNoticesIfDue)
      .then((result) => {
        if ('ran' in result) {
          app.log.info({ result }, 'auto notices executed');
        }
      })
      .catch((err) => {
        app.log.error({ err }, 'auto notices failed');
      });
  }

  // WhatsApp outbox: drain the send queue and poll delivery status on intervals.
  // Opt-out with ISPM_WHATSAPP_OUTBOX=off. Errors are swallowed so a transient
  // provider/network failure never crashes the backend. Timers are unref'd so
  // they never keep the process alive on shutdown.
  if (process.env.ISPM_WHATSAPP_OUTBOX !== 'off' && !process.env.VITEST) {
    // A verificação vai dentro do tick, não no registo: a licença pode ser
    // ativada (ou expirar à meia-noite) com a aplicação aberta. O `poll` de
    // estado de entrega corre sempre — reconcilia mensagens já enviadas, e
    // pará-lo deixava-as presas em "enviada, estado desconhecido".
    const drain = () => {
      if (!licenseAllowsWrites()) return;
      void runJob('whatsapp_drain', runWhatsappOutboxIfDue).catch(() => undefined);
    };
    const poll = () => { void runJob('whatsapp_poll', pollWhatsappDeliveryIfDue).catch(() => undefined); };
    drain();
    setInterval(drain, 60_000).unref();
    setInterval(poll, 180_000).unref();
  }

  // Scheduled backups: o arranque já faz um backup por sessão; este tick cobre
  // sessões longas, criando um backup quando passou `backupIntervalHours` desde
  // o último (idempotente, catch-up). Verifica de hora a hora; opt-out com
  // ISPM_SCHEDULED_BACKUP=off. Mesma disciplina de timer unref'd + erros engolidos.
  // Sem guarda de licenciamento, ao contrário das restantes tarefas: os dados são
  // do cliente e continuar a protegê-los nunca depende de estar em dia connosco.
  if (process.env.ISPM_SCHEDULED_BACKUP !== 'off' && !process.env.VITEST) {
    const backupTick = () => { void runJob('scheduled_backup', runScheduledBackupIfDue).catch((err) => app.log.error({ err }, 'scheduled backup failed')); };
    setInterval(backupTick, 3_600_000).unref();
  }

  // SMS companion outbox: dispatch queued SMS to the paired Android phone and
  // poll for approval/send status. Opt-out with ISPM_SMS_OUTBOX=off. Same
  // swallow-errors + unref'd timer discipline as the WhatsApp outbox.
  if (process.env.ISPM_SMS_OUTBOX !== 'off' && !process.env.VITEST) {
    const drainSms = () => {
      if (!licenseAllowsWrites()) return;
      void runJob('sms_drain', runSmsOutboxIfDue).catch(() => undefined);
    };
    const pollSms = () => { void runJob('sms_poll', pollSmsStatusIfDue).catch(() => undefined); };
    // Self-rescheduling so "Intervalo de envio SMS (segundos)" applies live —
    // each tick re-reads the setting instead of pinning a fixed setInterval.
    const scheduleDrain = () => {
      setTimeout(() => { drainSms(); scheduleDrain(); }, smsDispatchIntervalMs()).unref();
    };
    drainSms();
    scheduleDrain();
    setInterval(pollSms, 60_000).unref();
  }

  // Sonda de rede: ping periódico aos equipamentos com IP. Desligada por
  // definição até alguém a ligar em Definições; sem guarda de licenciamento
  // porque só lê a rede e não escreve nada do negócio. Opt-out com
  // ISPM_NETWORK_PROBE=off. Auto-reagendada, para o intervalo mudar a quente.
  if (process.env.ISPM_NETWORK_PROBE !== 'off' && !process.env.VITEST) {
    const probeTick = () => { void runJob('network_probe', runNetworkProbeIfDue).catch((err) => app.log.error({ err }, 'network probe failed')); };
    const scheduleProbe = () => {
      setTimeout(() => { probeTick(); scheduleProbe(); }, networkProbeIntervalMs()).unref();
    };
    probeTick();
    scheduleProbe();
  }

  // Reconciliação do acesso na rede (ADR 0007): compara a intenção da BD com o
  // que está no MikroTik e aplica a diferença. Desligada em Definições até
  // alguém a ligar, e em ensaio até alguém desligar o ensaio. Guarda de licença
  // como os outros jobs que escrevem. Opt-out com ISPM_ROUTEROS=off.
  if (process.env.ISPM_ROUTEROS !== 'off' && !process.env.VITEST) {
    const enforcementTick = () => {
      if (!licenseAllowsWrites()) return;
      void runJob('network_enforcement', runNetworkEnforcementIfDue)
        .catch((err) => app.log.error({ err }, 'network enforcement failed'));
    };
    const scheduleEnforcement = () => {
      setTimeout(() => { enforcementTick(); scheduleEnforcement(); }, routerosIntervalMs()).unref();
    };
    enforcementTick();
    scheduleEnforcement();
  }

  return app;
}

export async function startBackend() {
  if (serverStarted) {
    return;
  }

  const app = await createBackendApp();

  await app.listen({
    host: '127.0.0.1',
    port: 3001
  });

  serverStarted = true;
}

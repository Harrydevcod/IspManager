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
import { registerFinanceRoutes } from './routes/finance';
import { registerPlanRoutes } from './routes/plans';
import { registerReportRoutes } from './routes/reports';
import { registerSettingsRoutes } from './routes/settings';
import { registerTechnicalRoutes } from './routes/technical';
import { registerStockRoutes } from './routes/stock';
import { registerWhatsappRoutes } from './routes/whatsapp';
import { registerWorkOrderRoutes } from './routes/work-orders';
import { registerBackupRoutes } from './routes/backup';
import { createBackup, pruneBackups } from './lib/backup';
import { runMonthlyBillingIfDue } from './lib/auto-billing';

let serverStarted = false;

export async function createBackendApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'development'
  });

  await app.register(cors, {
    origin: ['http://127.0.0.1:5173']
  });

  getDatabase();

  // One consistent backup per boot. Availability > backup: never block the
  // app if the backup directory is unwritable.
  try {
    await createBackup('startup');
    pruneBackups();
  } catch (err) {
    app.log.error({ err }, 'startup backup failed');
  }

  // Auto-bill current month if today >= defaultDueDay and not yet billed
  // this month. Idempotent + opt-out via ISPM_AUTO_BILLING=off (tests).
  if (process.env.ISPM_AUTO_BILLING !== 'off') {
    try {
      const result = runMonthlyBillingIfDue();
      if ('ran' in result) {
        app.log.info({ result }, 'auto billing executed');
      }
    } catch (err) {
      app.log.error({ err }, 'auto billing failed');
    }
  }

  await registerAuthRoutes(app);
  await registerAuditRoutes(app);
  await registerUserRoutes(app);
  await registerHealthRoutes(app);
  await registerDashboardRoutes(app);
  await registerClientRoutes(app);
  await registerPlanRoutes(app);
  await registerInvestmentRoutes(app);
  await registerFinanceRoutes(app);
  await registerDocumentRoutes(app);
  await registerTechnicalRoutes(app);
  await registerStockRoutes(app);
  await registerReportRoutes(app);
  await registerSettingsRoutes(app);
  await registerWhatsappRoutes(app);
  await registerWorkOrderRoutes(app);
  await registerBackupRoutes(app);

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

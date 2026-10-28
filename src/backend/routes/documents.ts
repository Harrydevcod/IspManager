import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSqliteDatabase } from '../db/database';
import { recordAudit } from '../lib/audit';
import { PaymentDocumentError, filenamePart, renderPaymentDocumentPdf, renderReceiptPdf } from '../lib/documents';
import { fiscalQuerySchema, listFiscalDocuments } from '../lib/fiscal-documents';
import { loadMigrationCards, renderMigrationCardsPdf } from '../lib/pppoe-migration-cards';
import { confirmSessionPassword, requireRole } from './auth';
import { renderSaleTicketPdf } from '../lib/sale-ticket-documents';

const migrationCardsSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  scope: z.enum(['pending', 'all']).default('pending')
}).strict();

function archivalQuery(query: unknown): boolean {
  return !!query && typeof query === 'object' && 'archive' in query && (query as {archive:unknown}).archive === '1';
}

function dispositionFromQuery(query: unknown): 'inline' | 'attachment' {
  if (query && typeof query === 'object' && 'inline' in (query as Record<string, unknown>)) {
    const value = (query as Record<string, unknown>).inline;
    if (value === '1' || value === 'true' || value === true) return 'inline';
  }
  return 'attachment';
}

function documentDisposition(filename: string, query: unknown): string {
  // HTTP headers need an ASCII fallback; filename* keeps the UTF-8 name.
  const fallback = filenamePart(filename, 'documento.pdf').replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${dispositionFromQuery(query)}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function registerDocumentRoutes(app: FastifyInstance) {
  const canIssueDocuments = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/documents/fiscal', canIssueDocuments, async (request, reply) => {
    const parsed = fiscalQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({error:'Filtros inválidos'});
    return listFiscalDocuments(parsed.data);
  });

  // Fichas do técnico para a migração DHCP → PPPoE, com as senhas em claro. Mesmo
  // travão da revelação de uma senha (admin e a password outra vez), em lote.
  app.post('/api/services/pppoe-migration-cards.pdf', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const parsed = migrationCardsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Pedido inválido' });
    if (!(await confirmSessionPassword(request, reply, parsed.data.password))) return reply;

    const { cards, withoutPassword } = loadMigrationCards(getSqliteDatabase(), parsed.data.scope);
    const buffer = await renderMigrationCardsPdf(cards);
    recordAudit(request, {
      action: 'reveal_pppoe_password_batch',
      entityType: 'service',
      summary: `Gerou ${cards.length} fichas de migração PPPoE (${parsed.data.scope === 'pending' ? 'por migrar' : 'todas'})`,
      metadata: { serviceIds: cards.map((c) => c.serviceId), withoutPassword }
    });
    return reply.header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'no-store')
      .header('X-Cards-Count', String(cards.length))
      .header('X-Cards-Without-Password', String(withoutPassword.length))
      .header('Content-Disposition', 'attachment; filename="fichas-migracao-pppoe.pdf"')
      .send(buffer);
  });

  app.get('/api/payments/:id/sale-ticket.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const format = (request.query as { format?: unknown }).format ?? 'a4';
    if (format !== 'a4' && format !== 'a5' && format !== '80mm') return reply.status(400).send({ error: 'Formato inválido: use a4, a5 ou 80mm' });
    try {
      const { buffer, filename } = await renderSaleTicketPdf(id, format);
      return reply.header('Content-Type', 'application/pdf')
        .header('Cache-Control', 'no-store')
        .header('Content-Disposition', documentDisposition(filename, request.query))
        .send(buffer);
    } catch (error) {
      if (error instanceof PaymentDocumentError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/payments/:id/invoice.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'invoice', archivalQuery(request.query));
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', documentDisposition(filename, request.query))
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/payments/:id/receipt.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'receipt', archivalQuery(request.query));
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', documentDisposition(filename, request.query))
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // Um recibo concreto, por id. A rota por pagamento (acima) resolve para o
  // ultimo; esta imprime o de Marco quando e o de Marco que o cliente pede.
  app.get('/api/receipts/:id/receipt.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderReceiptPdf(id, archivalQuery(request.query));
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', documentDisposition(filename, request.query))
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}

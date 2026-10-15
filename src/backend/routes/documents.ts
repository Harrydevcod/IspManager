import type { FastifyInstance } from 'fastify';
import { PaymentDocumentError, filenamePart, renderPaymentDocumentPdf, renderReceiptPdf } from '../lib/documents';
import { fiscalQuerySchema, listFiscalDocuments } from '../lib/fiscal-documents';
import { requireRole } from './auth';
import { renderSaleTicketPdf } from '../lib/sale-ticket-documents';

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

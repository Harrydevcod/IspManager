import type { FastifyInstance } from 'fastify';
import { PaymentDocumentError, filenamePart, renderPaymentDocumentPdf } from '../lib/documents';
import { requireRole } from './auth';

function dispositionFromQuery(query: unknown): 'inline' | 'attachment' {
  if (query && typeof query === 'object' && 'inline' in (query as Record<string, unknown>)) {
    const value = (query as Record<string, unknown>).inline;
    if (value === '1' || value === 'true' || value === true) return 'inline';
  }
  return 'attachment';
}

export async function registerDocumentRoutes(app: FastifyInstance) {
  const canIssueDocuments = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/payments/:id/invoice.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'invoice');
      const disposition = dispositionFromQuery(request.query);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${filenamePart(filename, 'documento.pdf')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/payments/:id/receipt.pdf', canIssueDocuments, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    try {
      const { buffer, filename } = await renderPaymentDocumentPdf(id, 'receipt');
      const disposition = dispositionFromQuery(request.query);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `${disposition}; filename="${filenamePart(filename, 'documento.pdf')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    } catch (err) {
      if (err instanceof PaymentDocumentError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}

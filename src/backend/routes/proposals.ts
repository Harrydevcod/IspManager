import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from './auth';
import { actOnProposal, createProposal, getProposal, listProposals, ProposalError, proposalDraftSchema, proposalDeliveryDateSchema, updateProposal } from '../lib/proposals';
import { renderProposalPdf } from '../lib/proposal-documents';
import type { ProposalAction } from '../../shared/proposals';
const version = z.number().int().positive();
const schemas = {
    issue: z.object({ version }).strict(), revise: z.object({ version }).strict(),
    deliver: z.object({ version, deliveredAt: proposalDeliveryDateSchema, channel: z.string().trim().min(1).max(100), note: z.string().max(2000).optional() }).strict(),
    accept: z.object({ version, acceptedBy: z.string().trim().min(1).max(250), note: z.string().max(2000).optional() }).strict(),
    refuse: z.object({ version, reason: z.string().trim().min(1).max(2000) }).strict(), cancel: z.object({ version, reason: z.string().trim().min(1).max(2000) }).strict()
};
function handle(reply: FastifyReply, error: unknown) {
    if (error instanceof ProposalError) return reply.status(error.statusCode).send({ error: error.message });
    throw error;
}
const id = (request: FastifyRequest) => Number((request.params as {
    id: string;
}).id);
export async function registerProposalRoutes(app: FastifyInstance) {
    const access = { preHandler: requireRole(['admin', 'operator']) };
    app.get('/api/proposals', access, async (request, reply) => {
        const parsed = z.object({
            documentType: z.enum(['proposal','quotation','proforma']).optional(),
            page: z.coerce.number().int().positive().optional(),
            pageSize: z.coerce.number().int().min(1).max(100).optional(),
            search: z.string().max(250).optional(),
            status: z.enum(['draft','issued','accepted','refused','expired','cancelled','superseded']).optional(),
            clientId: z.coerce.number().int().positive().optional()
        }).strict().safeParse(request.query);
        if (!parsed.success) return reply.status(400).send({ error: 'Filtros inválidos' });
        try { return listProposals(parsed.data, request.user?.role); }
        catch (error) { return handle(reply,error); }
    });
    app.post('/api/proposals', access, async (request, reply) => {
        const parsed = proposalDraftSchema.safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: 'Dados de proposta inválidos' });
        try { return reply.status(201).send(createProposal(parsed.data,request)); }
        catch (error) { return handle(reply,error); }
    });
    app.get('/api/proposals/:id', access, async (request, reply) => {
        try { return getProposal(id(request),request.user?.role); }
        catch (error) { return handle(reply,error); }
    });
    app.patch('/api/proposals/:id', access, async (request, reply) => {
        const parsed = proposalDraftSchema.extend({version}).safeParse(request.body);
        if (!parsed.success) return reply.status(400).send({ error: 'Dados de proposta inválidos' });
        const {version:expected,...input} = parsed.data;
        try { return updateProposal(id(request),input,expected,request); }
        catch (error) { return handle(reply,error); }
    });
    for (const action of Object.keys(schemas) as ProposalAction[]) {
        app.post(`/api/proposals/:id/${action}`, access, async (request, reply) => {
            const parsed = schemas[action].safeParse(request.body);
            if (!parsed.success) return reply.status(400).send({ error: 'Dados de ação inválidos' });
            try { return actOnProposal(id(request),action,parsed.data,request); }
            catch (error) { return handle(reply,error); }
        });
    }
    app.get('/api/proposals/:id/proposal.pdf', access, async (request, reply) => {
        const format = (request.query as { format?: unknown }).format ?? 'a4';
        if (format !== 'a4' && format !== 'a5') return reply.status(400).send({ error: 'Formato inválido: use a4 ou a5' });
        try {
            getProposal(id(request),request.user?.role);
            const pdf = await renderProposalPdf(id(request), format);
            return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="${pdf.filename}"`).send(pdf.buffer);
        } catch (error) { return handle(reply,error); }
    });
}

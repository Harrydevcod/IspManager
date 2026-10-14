import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { getSqliteDatabase } from '../db/database';
import { recordAuditStrict } from './audit';
import { loadCompany, computeTotals } from './documents';
import type { UserRole } from './auth';
import type { Proposal, ProposalAction, ProposalDraftInput, ProposalLine, ProposalList, ProposalSnapshot, ProposalStatus, ProposalSummary, ProposalTax } from '../../shared/proposals';
export class ProposalError extends Error {
    constructor(message: string, public statusCode = 400) { super(message); }
}
const text = (max: number) => z.string().trim().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const lineSchema = z.object({
    kind: z.enum(['plan', 'installation', 'product', 'free']),
    description: text(2000).min(1),
    period: z.enum(['once', 'monthly']),
    quantity: z.number().positive().max(1000000).refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7),
    unitPriceCentavos: z.number().int().min(0).max(100000000000),
    planId: z.number().int().positive().nullable().optional(),
    catalogId: z.number().int().positive().nullable().optional()
}).strict().superRefine((line, context) => {
    if ((line.kind === 'plan' || line.kind === 'installation') && !Number.isInteger(line.quantity)) {
        context.addIssue({ code: 'custom', message: 'Quantidade de planos deve ser inteira' });
    }
    if ((line.kind === 'plan' && line.period !== 'monthly') || (line.kind === 'installation' && line.period !== 'once')) {
        context.addIssue({ code: 'custom', message: 'Periodicidade incompatível' });
    }
    if ((line.planId && line.kind !== 'plan' && line.kind !== 'installation') || (line.catalogId && line.kind !== 'product')) {
        context.addIssue({ code: 'custom', message: 'Referência incompatível' });
    }
});
export const proposalDraftSchema = z.object({
    clientId: z.number().int().positive().nullable(),
    recipient: z.object({ name: text(250).min(1), nif: text(30), phone: text(80), email: z.union([z.literal(''), text(254).email()]), address: text(1000) }).strict(),
    title: text(250).min(1),
    validUntil: date,
    conditions: text(12000),
    lines: z.array(lineSchema).min(1).max(100)
}).strict();
type Row = {
    id: number;
    number: string | null;
    client_id: number | null;
    recipient_json: string;
    title: string;
    valid_until: string;
    conditions: string;
    status: Exclude<ProposalStatus, 'expired'>;
    version: number;
    once_total_centavos: number;
    monthly_total_centavos: number;
    snapshot_json: string | null;
    previous_id: number | null;
    chain_id: number | null;
    created_by: number | null;
    created_at: string;
    issued_at: string | null;
    decision_at: string | null;
    accepted_by: string | null;
    decision_note: string | null;
    cancellation_reason: string | null;
};
function formatLocalDate(value: Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function today() { return formatLocalDate(new Date()); }
function authorize(role: UserRole) {
    if (role === 'technician') throw new ProposalError('Sem acesso a propostas', 403);
}
function row(id: number): Row {
    if (!Number.isSafeInteger(id) || id < 1) throw new ProposalError('Identificador inválido');
    const proposal = getSqliteDatabase().prepare('SELECT * FROM proposals WHERE id=?').get(id) as Row | undefined;
    if (!proposal) throw new ProposalError('Proposta não encontrada', 404);
    return proposal;
}
function status(proposal: Row): ProposalStatus {
    return proposal.status === 'issued' && proposal.valid_until < today() ? 'expired' : proposal.status;
}
function summary(proposal: Row): ProposalSummary {
    return {
        id: proposal.id, number: proposal.number, clientId: proposal.client_id,
        recipientName: JSON.parse(proposal.recipient_json).name, title: proposal.title,
        validUntil: proposal.valid_until, status: status(proposal), version: proposal.version,
        createdAt: proposal.created_at, issuedAt: proposal.issued_at,
        onceTotalCentavos: proposal.once_total_centavos, monthlyTotalCentavos: proposal.monthly_total_centavos,
        previousId: proposal.previous_id
    };
}
function actions(p: Row, role: UserRole): ProposalAction[] {
    const current = status(p);
    const pending = getSqliteDatabase().prepare("SELECT id FROM proposals WHERE chain_id=? AND status='draft' AND previous_id IS NOT NULL").get(p.chain_id);
    if (current === 'draft') {
        const predecessorAllowsIssue = !p.previous_id || ['issued', 'refused'].includes(row(p.previous_id).status);
        return predecessorAllowsIssue ? ['issue', 'cancel'] : ['cancel'];
    }
    if (current === 'issued') return pending ? ['deliver', 'accept', 'refuse', 'cancel'] : ['deliver', 'accept', 'refuse', 'cancel', 'revise'];
    if (current === 'expired' || current === 'refused') return pending ? ['cancel'] : ['cancel', 'revise'];
    if (current === 'accepted') return role === 'admin' ? ['cancel'] : [];
    return [];
}
export function getProposal(id: number, role: UserRole = 'admin'): Proposal {
    authorize(role);
    const proposal = row(id);
    const db = getSqliteDatabase();
    const lines = db.prepare(`SELECT id,sort_order sortOrder,kind,description,period,quantity,
        unit_price_centavos unitPriceCentavos,total_centavos totalCentavos,plan_id planId,catalog_id catalogId
        FROM proposal_lines WHERE proposal_id=? ORDER BY sort_order`).all(id) as ProposalLine[];
    const deliveries = db.prepare(`SELECT id,delivered_at deliveredAt,channel,note,actor_user_id actorUserId
        FROM proposal_deliveries WHERE proposal_id=? ORDER BY id`).all(id) as Proposal['deliveries'];
    const chain = (db.prepare('SELECT * FROM proposals WHERE chain_id=? ORDER BY id').all(proposal.chain_id ?? id) as Row[]).map(summary);
    return {
        ...summary(proposal), recipient: JSON.parse(proposal.recipient_json), conditions: proposal.conditions,
        snapshot: proposal.snapshot_json ? JSON.parse(proposal.snapshot_json) : null, createdBy: proposal.created_by,
        decisionAt: proposal.decision_at, acceptedBy: proposal.accepted_by, decisionNote: proposal.decision_note,
        cancellationReason: proposal.cancellation_reason, lines, deliveries, chain, allowedActions: actions(proposal, role)
    };
}
function validate(input: ProposalDraftInput) {
    const parsed = proposalDraftSchema.safeParse(input);
    if (!parsed.success) throw new ProposalError('Dados de proposta inválidos');
    const data = parsed.data;
    const db = getSqliteDatabase();
    if (data.clientId) {
        const client = db.prepare('SELECT system_kind FROM clients WHERE id=?').get(data.clientId) as {system_kind: string | null} | undefined;
        if (!client || client.system_kind) throw new ProposalError('Cliente indisponível para propostas');
    }
    let once = 0;
    let monthly = 0;
    const lines = data.lines.map(line => {
        if (line.planId && !db.prepare('SELECT id FROM internet_plans WHERE id=?').get(line.planId)) throw new ProposalError('Plano inexistente');
        if (line.catalogId && !db.prepare('SELECT id FROM equipment_catalog WHERE id=?').get(line.catalogId)) throw new ProposalError('Produto inexistente');
        // Integer thousandths avoid floating-point half-cent errors; round each line, then aggregate.
        const totalCentavos = Number((BigInt(line.unitPriceCentavos) * BigInt(Math.round(line.quantity * 1000)) + 500n) / 1000n);
        if (!Number.isSafeInteger(totalCentavos)) throw new ProposalError('Valor demasiado elevado');
        if (line.period === 'once') once += totalCentavos;
        else monthly += totalCentavos;
        return {...line, totalCentavos};
    });
    if (!Number.isSafeInteger(once) || !Number.isSafeInteger(monthly) || (once === 0 && monthly === 0)) {
        throw new ProposalError('A proposta exige pelo menos um total positivo');
    }
    return {data, lines, once, monthly};
}
function saveLines(id: number, lines: ReturnType<typeof validate>['lines']) {
    const db = getSqliteDatabase();
    db.prepare('DELETE FROM proposal_lines WHERE proposal_id=?').run(id);
    const insert = db.prepare(`INSERT INTO proposal_lines(proposal_id,sort_order,kind,description,period,quantity,
        unit_price_centavos,total_centavos,plan_id,catalog_id) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    lines.forEach((line, index) => insert.run(id,index,line.kind,line.description,line.period,line.quantity,
        line.unitPriceCentavos,line.totalCentavos,line.planId ?? null,line.catalogId ?? null));
}
function audit(id: number, action: string, request?: FastifyRequest) {
    recordAuditStrict(getSqliteDatabase(), request ?? ({} as FastifyRequest), {
        action, entityType: 'proposal', entityId: id, summary: `Proposta: ${action}`
    });
}
function insertDraft(input: ProposalDraftInput, request?: FastifyRequest, previous?: Row) {
    const {data, lines, once, monthly} = validate(input);
    const db = getSqliteDatabase();
    const id = Number(db.prepare(`INSERT INTO proposals(client_id,recipient_json,title,valid_until,conditions,
        once_total_centavos,monthly_total_centavos,created_by,previous_id,chain_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(data.clientId,JSON.stringify(data.recipient),data.title,data.validUntil,data.conditions,once,monthly,
            request?.user?.id ?? null,previous?.id ?? null,previous?.chain_id ?? null).lastInsertRowid);
    if (!previous) db.prepare('UPDATE proposals SET chain_id=? WHERE id=?').run(id,id);
    saveLines(id,lines);
    audit(id,previous ? 'revise' : 'create',request);
    return id;
}
export function createProposal(input: ProposalDraftInput, request?: FastifyRequest): Proposal {
    const role = request?.user?.role ?? 'admin';
    authorize(role);
    const id = getSqliteDatabase().transaction(() => insertDraft(input,request)).immediate();
    return getProposal(id,role);
}
function checkVersion(proposal: Row, version: number) {
    if (!Number.isSafeInteger(version) || version < 1) throw new ProposalError('Versão obrigatória');
    if (proposal.version !== version) throw new ProposalError('A proposta foi alterada. Atualize antes de continuar.',409);
}
export function updateProposal(id: number, input: ProposalDraftInput, version: number, request?: FastifyRequest): Proposal {
    const role = request?.user?.role ?? 'admin';
    authorize(role);
    getSqliteDatabase().transaction(() => {
        const proposal = row(id);
        checkVersion(proposal,version);
        if (proposal.status !== 'draft') throw new ProposalError('A proposta emitida é imutável',409);
        const {data,lines,once,monthly} = validate(input);
        getSqliteDatabase().prepare(`UPDATE proposals SET client_id=?,recipient_json=?,title=?,valid_until=?,conditions=?,
            once_total_centavos=?,monthly_total_centavos=?,version=version+1 WHERE id=?`)
            .run(data.clientId,JSON.stringify(data.recipient),data.title,data.validUntil,data.conditions,once,monthly,id);
        saveLines(id,lines);
        audit(id,'update',request);
    }).immediate();
    return getProposal(id,role);
}
function snapshot(proposal: Row): ProposalSnapshot {
    const company = loadCompany();
    const tax = (amount: number): ProposalTax => {
        const totals = computeTotals(amount / 100,company);
        const subtotalCentavos = Math.round(totals.subtotal * 100);
        return {subtotalCentavos,ivaCentavos:amount-subtotalCentavos,totalCentavos:amount,
            ivaRate:totals.ivaRate,isExempt:totals.isExempt,exemptReason:totals.exemptReason};
    };
    return {
        company: {companyName:company.companyName,nif:company.nif,phone:company.phone,email:company.email,
            address:company.address,island:company.island,currencyCode:company.currencyCode,ivaRate:company.ivaRate,
            fiscalRegime:company.fiscalRegime,showIva:company.showIva,legalNotes:company.legalNotes},
        onceTax:tax(proposal.once_total_centavos),monthlyTax:tax(proposal.monthly_total_centavos)
    };
}
export type ProposalActionInput = {
    version: number;
    deliveredAt?: string;
    channel?: string;
    note?: string;
    acceptedBy?: string;
    reason?: string;
};
function required(value: unknown, max = 2000) {
    const result = text(max).min(1).safeParse(value);
    if (!result.success) throw new ProposalError('Preencha a identificação ou motivo obrigatório');
    return result.data;
}
export const proposalDeliveryDateSchema = z.union([date,z.string().datetime({offset:true})]);
function issueProposal(proposal: Row, request?: FastifyRequest) {
    const db = getSqliteDatabase();
    if (proposal.valid_until < today()) throw new ProposalError('A validade já terminou');
    if (proposal.previous_id) {
        const previous = row(proposal.previous_id);
        if (!['issued','refused'].includes(previous.status)) throw new ProposalError('A versão anterior já não pode ser substituída',409);
        db.prepare("UPDATE proposals SET status='superseded',version=version+1 WHERE id=?").run(previous.id);
        audit(previous.id,'supersede',request);
    }
    const year = new Date().getFullYear();
    const sequence = db.prepare(`INSERT INTO proposal_sequences(year,last_number) VALUES(?,1)
        ON CONFLICT(year) DO UPDATE SET last_number=last_number+1 RETURNING last_number`).get(year) as {last_number:number};
    db.prepare("UPDATE proposals SET number=?,status='issued',issued_at=?,snapshot_json=?,version=version+1 WHERE id=?")
        .run(`PR-${year}-${String(sequence.last_number).padStart(5,'0')}`,new Date().toISOString(),JSON.stringify(snapshot(proposal)),proposal.id);
}
function reviseProposal(proposal: Row, role: UserRole, request?: FastifyRequest) {
    const current = getProposal(proposal.id,role);
    const validity = new Date();
    validity.setDate(validity.getDate()+30);
    return insertDraft({
        clientId:proposal.client_id,recipient:current.recipient,title:proposal.title,conditions:proposal.conditions,
        validUntil:formatLocalDate(validity),
        lines:current.lines.map(({kind,description,period,quantity,unitPriceCentavos,planId,catalogId}) =>
            ({kind,description,period,quantity,unitPriceCentavos,planId,catalogId}))
    },request,proposal);
}
function deliverProposal(proposal: Row, input: ProposalActionInput, request?: FastifyRequest) {
    const delivery = proposalDeliveryDateSchema.safeParse(input.deliveredAt);
    if (!delivery.success) throw new ProposalError('Data de entrega inválida');
    const note = text(2000).safeParse(input.note ?? '');
    if (!note.success) throw new ProposalError('Observação demasiado longa');
    const db = getSqliteDatabase();
    db.prepare('INSERT INTO proposal_deliveries(proposal_id,delivered_at,channel,note,actor_user_id) VALUES(?,?,?,?,?)')
        .run(proposal.id,delivery.data,required(input.channel,100),note.data,request?.user?.id ?? null);
    db.prepare('UPDATE proposals SET version=version+1 WHERE id=?').run(proposal.id);
}
function acceptProposal(proposal: Row, input: ProposalActionInput) {
    const note = text(2000).safeParse(input.note ?? '');
    if (!note.success) throw new ProposalError('Nota demasiado longa');
    getSqliteDatabase().prepare("UPDATE proposals SET status='accepted',decision_at=?,accepted_by=?,decision_note=?,version=version+1 WHERE id=?")
        .run(new Date().toISOString(),required(input.acceptedBy,250),note.data,proposal.id);
}
function refuseProposal(proposal: Row, input: ProposalActionInput) {
    getSqliteDatabase().prepare("UPDATE proposals SET status='refused',decision_at=?,decision_note=?,version=version+1 WHERE id=?")
        .run(new Date().toISOString(),required(input.reason),proposal.id);
}
function cancelProposal(proposal: Row, input: ProposalActionInput) {
    getSqliteDatabase().prepare("UPDATE proposals SET status='cancelled',cancellation_reason=?,snapshot_json=COALESCE(snapshot_json,?),version=version+1 WHERE id=?")
        .run(required(input.reason),JSON.stringify(snapshot(proposal)),proposal.id);
}
export function actOnProposal(id: number, action: ProposalAction, input: ProposalActionInput, request?: FastifyRequest): Proposal {
    const role = request?.user?.role ?? 'admin';
    authorize(role);
    const db = getSqliteDatabase();
    const result = db.transaction(() => {
        const p = row(id);
        if (action === 'issue' && p.number)
            return id;
        checkVersion(p, input.version);
        if (action === 'cancel' && p.status === 'accepted' && role !== 'admin') {
            throw new ProposalError('Só administradores podem cancelar propostas aceites', 403);
        }
        if (!actions(p, role).includes(action))
            throw new ProposalError('Ação indisponível neste estado', 409);
        if (action === 'revise') return reviseProposal(p,role,request);
        if (action === 'issue') issueProposal(p,request);
        else if (action === 'deliver') deliverProposal(p,input,request);
        else if (action === 'accept') acceptProposal(p,input);
        else if (action === 'refuse') refuseProposal(p,input);
        else if (action === 'cancel') cancelProposal(p,input);
        audit(id, action, request);
        return id;
    }).immediate();
    return getProposal(result, role);
}
export function listProposals(query: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: ProposalStatus;
    clientId?: number;
} = {}, role: UserRole = 'admin'): ProposalList {
    authorize(role);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw new ProposalError('Paginação inválida');
    }
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (query.search) {
        where.push("(number LIKE ? ESCAPE '\\' OR json_extract(recipient_json,'$.name') LIKE ? ESCAPE '\\')");
        const search = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
        values.push(search,search);
    }
    if (query.status) {
        if (query.status === 'expired') {
            where.push("status='issued' AND valid_until < ?");
            values.push(today());
        } else {
            where.push('status=?');
            values.push(query.status);
            if (query.status === 'issued') {
                where.push('valid_until >= ?');
                values.push(today());
            }
        }
    }
    if (query.clientId) {
        where.push('client_id=?');
        values.push(query.clientId);
    }
    const clause = where.length ? ' WHERE '+where.join(' AND ') : '';
    const db = getSqliteDatabase();
    const total = (db.prepare('SELECT count(*) total FROM proposals'+clause).get(...values) as {total:number}).total;
    const items = (db.prepare('SELECT * FROM proposals'+clause+' ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(...values,pageSize,(page-1)*pageSize) as Row[]).map(summary);
    return {items,total,page,pageSize};
}

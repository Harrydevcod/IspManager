import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProposalDraftInput } from '../../shared/proposals';
let api: typeof import('./proposals');
let database: typeof import('../db/database');
let dir: string;
const draft: ProposalDraftInput = { clientId: null, recipient: { name: 'Interessado', nif: '', phone: '', email: '', address: '' }, title: 'Internet', validUntil: '2099-01-01', conditions: 'Instalação a combinar', lines: [{ kind: 'free', description: 'Mensalidade', period: 'monthly', quantity: 1, unitPriceCentavos: 250000 }, { kind: 'free', description: 'Instalação oferecida', period: 'once', quantity: 1, unitPriceCentavos: 0 }, { kind: 'product', description: 'Cabo', period: 'once', quantity: 1.125, unitPriceCentavos: 101 }] };
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'ispm-proposals-')); process.env.ISPM_DATA_DIR = dir; database = await import('../db/database'); database.getDatabase(); api = await import('./proposals'); });
afterAll(() => { database.closeDatabaseForTests(); delete process.env.ISPM_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });
describe('propostas independentes', () => {
    test('expiração é derivada em detalhe e filtros sem escrever dados', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
            const p = api.createProposal({...draft,validUntil:'2026-10-02'});
            const issued = api.actOnProposal(p.id,'issue',{version:p.version});
            const before = database.getSqliteDatabase().prepare('SELECT * FROM proposals WHERE id=?').get(p.id);
            vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
            expect(api.getProposal(p.id).status).toBe('expired');
            expect(api.listProposals({status:'expired'}).items.map(p=>p.id)).toContain(p.id);
            expect(api.listProposals({status:'issued'}).items.map(p=>p.id)).not.toContain(p.id);
            expect(()=>api.actOnProposal(p.id,'accept',{version:issued.version,acceptedBy:'Maria'})).toThrow();
            expect(database.getSqliteDatabase().prepare('SELECT * FROM proposals WHERE id=?').get(p.id)).toEqual(before);
            const revision = api.actOnProposal(p.id,'revise',{version:issued.version});
            expect(revision.status).toBe('draft');
            expect(api.getProposal(p.id).status).toBe('expired');
        } finally {vi.useRealTimers();}
    });
    test('substituição impede aceitar a versão anterior mesmo com versão atualizada', () => {
        const p=api.createProposal(draft);
        const issued=api.actOnProposal(p.id,'issue',{version:p.version});
        const revision=api.actOnProposal(p.id,'revise',{version:issued.version});
        expect(api.getProposal(p.id).allowedActions).not.toContain('revise');
        api.actOnProposal(revision.id,'issue',{version:revision.version});
        const old=api.getProposal(p.id);
        expect(()=>api.actOnProposal(p.id,'accept',{version:old.version,acceptedBy:'Maria'})).toThrow();
    });
    test('100 linhas permitidas, 101 recusadas e arredondamento de meios centavos por linha', () => {
        const line={kind:'free' as const,description:'Linha',period:'once' as const,quantity:0.5,unitPriceCentavos:1};
        const p=api.createProposal({...draft,lines:Array.from({length:100},()=>({...line}))});
        expect(p.onceTotalCentavos).toBe(100);
        const decimal=api.createProposal({...draft,lines:[{...line,quantity:0.145,unitPriceCentavos:100}]});
        expect(decimal.onceTotalCentavos).toBe(15);
        expect(()=>api.createProposal({...draft,lines:Array.from({length:101},()=>({...line}))})).toThrow();
    });
    test('múltiplos planos, instalação gratuita e venda/aluguer mantêm períodos e dados após remoção de referências', () => {
        const db=database.getSqliteDatabase();
        const clientId=Number(db.prepare("INSERT INTO clients(client_code,full_name) VALUES ('PROPOSAL','Original')").run().lastInsertRowid);
        const planId=Number(db.prepare("INSERT INTO internet_plans(name,download_speed,upload_speed,monthly_price_cve,installation_fee_cve) VALUES ('Plano original','10','10',2000,1000)").run().lastInsertRowid);
        const catalogId=Number(db.prepare("INSERT INTO equipment_catalog(brand,model,type) VALUES ('TP-Link','Router original','router')").run().lastInsertRowid);
        const p=api.createProposal({...draft,clientId,lines:[
            {kind:'plan',description:'Plano original',period:'monthly',quantity:2,unitPriceCentavos:200000,planId},
            {kind:'installation',description:'Instalação oferecida',period:'once',quantity:2,unitPriceCentavos:0,planId},
            {kind:'plan',description:'Segunda oferta',period:'monthly',quantity:1,unitPriceCentavos:300000,planId},
            {kind:'product',description:'Router vendido',period:'once',quantity:1,unitPriceCentavos:100000,catalogId},
            {kind:'product',description:'Router alugado',period:'monthly',quantity:1,unitPriceCentavos:20000,catalogId}
        ]});
        const issued=api.actOnProposal(p.id,'issue',{version:p.version});
        db.prepare("UPDATE internet_plans SET name='Changed',monthly_price_cve=9999 WHERE id=?").run(planId);
        db.prepare("UPDATE clients SET full_name='Changed' WHERE id=?").run(clientId);
        db.prepare("UPDATE equipment_catalog SET model='Changed' WHERE id=?").run(catalogId);
        expect(api.getProposal(p.id)).toEqual(issued);
        db.prepare('DELETE FROM clients WHERE id=?').run(clientId);
        db.prepare('DELETE FROM internet_plans WHERE id=?').run(planId);
        db.prepare('DELETE FROM equipment_catalog WHERE id=?').run(catalogId);
        const preserved=api.getProposal(p.id);
        expect(preserved.recipient).toEqual(issued.recipient);
        expect(preserved.snapshot).toEqual(issued.snapshot);
        expect(preserved.clientId).toBeNull();
        expect(preserved.lines.map(line=>[line.description,line.unitPriceCentavos,line.totalCentavos])).toEqual(issued.lines.map(line=>[line.description,line.unitPriceCentavos,line.totalCentavos]));
        expect(preserved.onceTotalCentavos).toBe(100000);
        expect(preserved.monthlyTotalCentavos).toBe(720000);
    });
    test('IVA incluído é apresentado e arredondado separadamente', () => {
        const db=database.getSqliteDatabase();
        for(const [key,value] of [['showIva','true'],['fiscalRegime','normal'],['ivaRate','15']]) db.prepare('INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)').run(key,value);
        const p=api.createProposal(draft);
        const issued=api.actOnProposal(p.id,'issue',{version:p.version});
        expect(issued.snapshot?.onceTax).toMatchObject({subtotalCentavos:99,ivaCentavos:15,totalCentavos:114,ivaRate:15});
        expect(issued.snapshot?.monthlyTax).toMatchObject({subtotalCentavos:217391,ivaCentavos:32609,totalCentavos:250000});
        db.prepare("UPDATE app_settings SET value='rempe' WHERE key='fiscalRegime'").run();
        expect(api.getProposal(p.id).snapshot).toEqual(issued.snapshot);
        const exempt=api.createProposal(draft);
        expect(api.actOnProposal(exempt.id,'issue',{version:exempt.version}).snapshot?.monthlyTax).toMatchObject({ivaCentavos:0,isExempt:true});
    });
    test('cancelar rascunho congela apresentação e cancelar aceite preserva decisão', () => {
        const p=api.createProposal(draft);
        const cancelled=api.actOnProposal(p.id,'cancel',{version:p.version,reason:'Erro'});
        expect(cancelled.snapshot).not.toBeNull();expect(cancelled.number).toBeNull();
        const other=api.createProposal(draft);
        const issued=api.actOnProposal(other.id,'issue',{version:other.version});
        const accepted=api.actOnProposal(other.id,'accept',{version:issued.version,acceptedBy:'Maria',note:'Confirmado por telefone'});
        expect(()=>api.actOnProposal(other.id,'cancel',{version:accepted.version,reason:'Mudança'},{user:{role:'operator'}} as never)).toThrow('Só administradores');
        const final=api.actOnProposal(other.id,'cancel',{version:accepted.version,reason:'Mudança'});
        expect(final.decisionNote).toBe('Confirmado por telefone');expect(final.acceptedBy).toBe('Maria');expect(final.cancellationReason).toBe('Mudança');
    });
    test('cada mutação reverte perante falha de auditoria incluindo entregas e revisão', () => {
        const db=database.getSqliteDatabase();
        const initial=api.createProposal(draft);
        const issued=api.actOnProposal(initial.id,'issue',{version:initial.version});
        const editable=api.createProposal(draft);
        const fail=()=>db.exec("CREATE TRIGGER proposal_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.entity_type = 'proposal' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
        const clear=()=>db.exec('DROP TRIGGER proposal_audit_failure');
        for(const action of ['deliver','accept','refuse','cancel','revise'] as const) {
            const before=api.getProposal(issued.id);fail();
            try {expect(()=>api.actOnProposal(issued.id,action,{version:before.version,deliveredAt:'2026-10-13',channel:'Email',acceptedBy:'Maria',reason:'Teste'})).toThrow('audit failed');}
            finally {clear();}
            expect(api.getProposal(issued.id)).toEqual(before);
        }
        fail();try {expect(()=>api.updateProposal(editable.id,{...draft,title:'Changed'},editable.version)).toThrow('audit failed');expect(()=>api.createProposal(draft)).toThrow('audit failed');}finally{clear();}
        expect(api.getProposal(editable.id).title).toBe(draft.title);
        const revision=api.actOnProposal(issued.id,'revise',{version:issued.version});
        const count=db.prepare('SELECT * FROM proposal_sequences').all();fail();
        try {expect(()=>api.actOnProposal(revision.id,'issue',{version:revision.version})).toThrow('audit failed');}finally{clear();}
        expect(api.getProposal(issued.id).status).toBe('issued');expect(api.getProposal(revision.id).status).toBe('draft');expect(db.prepare('SELECT * FROM proposal_sequences').all()).toEqual(count);
    });
    test('arredonda linhas, emite idempotentemente e congela a empresa', () => {
        const p = api.createProposal(draft);
        expect(p.onceTotalCentavos).toBe(114);
        expect(p.monthlyTotalCentavos).toBe(250000);
        const issued = api.actOnProposal(p.id, 'issue', { version: p.version });
        expect(issued.number).toMatch(/^PR-\d{4}-\d{5}$/);
        expect(api.actOnProposal(p.id, 'issue', { version: 1 }).number).toBe(issued.number);
        database.getSqliteDatabase().prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('companyName','Changed')").run();
        expect(api.getProposal(p.id).snapshot?.company.companyName).toBe(issued.snapshot?.company.companyName);
        expect(() => api.updateProposal(p.id, draft, issued.version)).toThrow();
    });
    test('revisão pendente única e aceitação impede a emissão da revisão', () => {
        const p = api.createProposal(draft);
        const issued = api.actOnProposal(p.id, 'issue', { version: p.version });
        const rev = api.actOnProposal(p.id, 'revise', { version: issued.version });
        expect(() => api.actOnProposal(p.id, 'revise', { version: issued.version })).toThrow();
        const current = api.getProposal(p.id);
        api.actOnProposal(p.id, 'accept', { version: current.version, acceptedBy: 'Maria' });
        expect(() => api.actOnProposal(rev.id, 'issue', { version: rev.version })).toThrow();
    });
    test('emissão substitui anterior, preserva cadeia e não altera contabilidade', () => {
        const db = database.getSqliteDatabase();
        const counts = () => ['payments', 'services', 'clients', 'stock_movements', 'treasury_movements'].map(t => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as {
            n: number;
        }).n);
        const before = counts();
        const p = api.createProposal(draft);
        const issued = api.actOnProposal(p.id, 'issue', { version: p.version });
        const rev = api.actOnProposal(p.id, 'revise', { version: issued.version });
        api.actOnProposal(rev.id, 'issue', { version: rev.version });
        expect(api.getProposal(p.id).status).toBe('superseded');
        expect(api.getProposal(rev.id).chain).toHaveLength(2);
        expect(counts()).toEqual(before);
    });
    test('auditoria falhada reverte número, congelamento e substituição', () => {
        const p = api.createProposal(draft);
        const db = database.getSqliteDatabase();
        db.exec("CREATE TRIGGER proposal_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.entity_type = 'proposal' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
        expect(() => api.actOnProposal(p.id, 'issue', { version: p.version })).toThrow();
        db.exec('DROP TRIGGER proposal_audit_failure');
        expect(api.getProposal(p.id).status).toBe('draft');
        expect(api.getProposal(p.id).number).toBeNull();
    });
    test('valida quantidades, total positivo e versão; técnicos recusados', () => {
        expect(() => api.createProposal({ ...draft, lines: [{ ...draft.lines[0], quantity: 1.0001 }] })).toThrow();
        expect(() => api.createProposal({ ...draft, lines: [{ ...draft.lines[0], kind: 'plan', quantity: 1.5 }] })).toThrow();
        expect(() => api.createProposal({ ...draft, lines: [draft.lines[1]] })).toThrow();
        const p = api.createProposal(draft);
        expect(() => api.updateProposal(p.id, draft, 999)).toThrow();
        expect(() => api.getProposal(p.id, 'technician')).toThrow();
    });
});


describe('documentos informativos', () => {
    const paymentRequest = { amountCentavos: 3000000, description: 'Instalação e doze mensalidades', conditions: 'Transferência banc?ria', dueDate: null };
    test('legacy inputs, independent series, inherited revisions and immutable type', () => {
        expect(api.createProposal(draft).documentType).toBe('proposal');
        const numbers: string[] = [];
        for (const documentType of ['quotation', 'proforma'] as const) {
            const p = api.createProposal({...draft, documentType, paymentRequest: documentType === 'proforma' ? paymentRequest : null});
            const oldInput = api.updateProposal(p.id, {...draft, title: 'Legacy update'}, p.version);
            expect(oldInput.documentType).toBe(documentType);
            expect(oldInput.paymentRequest).toEqual(documentType === 'proforma' ? paymentRequest : null);
            const issued = api.actOnProposal(p.id, 'issue', {version: oldInput.version});
            numbers.push(issued.number!);
            const rev = api.actOnProposal(p.id, 'revise', {version: issued.version});
            expect(rev.documentType).toBe(documentType);
            expect(() => api.updateProposal(rev.id, {...draft, documentType:'proposal'}, rev.version)).toThrow();
            expect(() => api.updateProposal(p.id, {...draft, documentType:'proposal'}, issued.version)).toThrow();
        }
        expect(numbers[0]).toMatch(/^OR-\d{4}-00001$/);
        expect(numbers[1]).toMatch(/^PF-\d{4}-00001$/);
        expect(api.listProposals({documentType:'proforma'}).items.every(p => p.documentType === 'proforma')).toBe(true);
    });
    test('payment validation and switching clears request', () => {
        for (const amountCentavos of [0, -1, 1.5, 100000000001, Infinity])
            expect(() => api.createProposal({...draft, documentType:'proforma', paymentRequest:{...paymentRequest, amountCentavos}})).toThrow();
        for (const patch of [{description:' '}, {conditions:' '}, {dueDate:'2026-02-30'}])
            expect(() => api.createProposal({...draft, documentType:'proforma', paymentRequest:{...paymentRequest, ...patch}})).toThrow();
        expect(() => api.createProposal({...draft, documentType:'proforma'})).toThrow();
        const p = api.createProposal({...draft, documentType:'proforma', paymentRequest});
        expect(p.paymentRequest?.amountCentavos).toBe(3000000);
        expect(api.updateProposal(p.id, {...draft, documentType:'quotation'}, p.version).paymentRequest).toBeNull();
    });
    test('snapshots freeze request, numbering rolls back on audit failure, no financial side effects', () => {
        const db = database.getSqliteDatabase();
        const counts = () => ['payments','payment_receipts','services','clients'].map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
        const before = counts();
        const p = api.createProposal({...draft, documentType:'proforma', paymentRequest});
        db.exec("CREATE TRIGGER proforma_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.entity_type='proposal' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
        const sequence = db.prepare('SELECT * FROM proforma_sequences').all();
        try { expect(() => api.actOnProposal(p.id,'issue',{version:p.version})).toThrow('audit failed'); }
        finally { db.exec('DROP TRIGGER proforma_audit_failure'); }
        expect(db.prepare('SELECT * FROM proforma_sequences').all()).toEqual(sequence);
        const issued = api.actOnProposal(p.id,'issue',{version:p.version});
        expect(issued.snapshot?.paymentRequest).toEqual(paymentRequest);
        expect(Array.isArray(issued.snapshot?.bankAccounts)).toBe(true);
        api.actOnProposal(p.id,'accept',{version:issued.version,acceptedBy:'Maria'});
        expect(counts()).toEqual(before);
    });
});

test('issued proforma PDFs keep printed treasury account after settings changes', async () => {
  const db=database.getSqliteDatabase();
  const bank=Number(db.prepare("INSERT INTO treasury_accounts(kind,name,bank_name,account_number,opening_date,show_on_documents) VALUES ('banco','Original','Banco congelado','CONTA ORIGINAL','2026-01-01',1)").run().lastInsertRowid);
  const p=api.createProposal({...draft,documentType:'proforma',paymentRequest:{amountCentavos:3000000,description:'Doze meses',conditions:'Transferência',dueDate:null}});
  const issued=api.actOnProposal(p.id,'issue',{version:p.version});
  expect(issued.snapshot?.bankAccounts?.some(account=>account.accountNumber==='CONTA ORIGINAL')).toBe(true);
  db.prepare("UPDATE treasury_accounts SET bank_name='Banco alterado',account_number='CONTA ALTERADA',show_on_documents=0 WHERE id=?").run(bank);
  const {renderProposalPdf}=await import('./proposal-documents'); const {inspectPdfLayout}=await import('./pdf.testing');
  for(const format of ['a4','a5'] as const){
    const text=inspectPdfLayout((await renderProposalPdf(p.id,format)).buffer).text.flat().map(item=>item.value).join(' ');
    expect(text).toContain('CONTA ORIGINAL'); expect(text).not.toContain('CONTA ALTERADA');
  }
});
test('each informative series resets independently in the next issue year',()=>{
  vi.useFakeTimers();
  try {
    for(const year of [2088,2089]) {
      vi.setSystemTime(new Date(`${year}-01-02T12:00:00Z`));
      for(const documentType of ['proposal','quotation','proforma'] as const){
        const p=api.createProposal({...draft,documentType,paymentRequest:documentType==='proforma'?{amountCentavos:100,description:'Um mês',conditions:'Transferência',dueDate:null}:null});
        expect(api.actOnProposal(p.id,'issue',{version:p.version}).number).toBe(`${{proposal:'PR',quotation:'OR',proforma:'PF'}[documentType]}-${year}-00001`);
      }
    }
  } finally {vi.useRealTimers();}
});

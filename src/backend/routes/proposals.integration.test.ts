import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Proposal, ProposalDraftInput } from '../../shared/proposals';

let app: FastifyInstance;
let db: Database.Database;
let directory: string;
let close: () => void;
const tokens: Record<string, string> = {};
const headers = (role = 'admin') => ({ authorization: `Bearer ${tokens[role]}` });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'ispm-proposal-contract-'));
  process.env.ISPM_DATA_DIR = directory;
  process.env.ISPM_AUTO_BILLING = 'off';
  process.env.ISPM_RECURRING_EXPENSES = 'off';
  delete process.env.ISPM_AUTH;
  const server = await import('../server');
  const database = await import('../db/database');
  app = await server.createBackendApp();
  await app.ready();
  db = database.getSqliteDatabase();
  close = database.closeDatabaseForTests;
  const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: {
    username: 'admin', fullName: 'Administrator', password: 'proposal-contract-secret'
  } });
  expect(setup.statusCode).toBe(201);
  tokens.admin = setup.json().token;
  for (const role of ['operator', 'technician']) {
    const user = await app.inject({ method: 'POST', url: '/api/users', headers: headers(),
      payload: { username: role, fullName: role, role, password: 'proposal-contract-secret' } });
    expect(user.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { username: role, password: 'proposal-contract-secret' } });
    expect(login.statusCode).toBe(200);
    tokens[role] = login.json().token;
  }
});
afterAll(async () => {
  await app?.close();
  close?.();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.ISPM_DATA_DIR;
  delete process.env.ISPM_AUTO_BILLING;
  delete process.env.ISPM_RECURRING_EXPENSES;
});
const input = (): ProposalDraftInput => ({ clientId: null,
  recipient: { name: 'Restaurante Atlântico', nif: '', email: '', phone: '', address: 'Praia' },
  title: 'Internet empresarial', validUntil: '2099-12-31', conditions: 'Instalação oferecida.',
  lines: [
    { kind: 'free', description: 'Mensalidade internet', period: 'monthly', quantity: 1, unitPriceCentavos: 350000 },
    { kind: 'free', description: 'Instalação oferecida', period: 'once', quantity: 1, unitPriceCentavos: 0 },
    { kind: 'free', description: 'Cabo adicional', period: 'once', quantity: 12.125, unitPriceCentavos: 2550 }
  ]
});
async function create(role = 'operator') {
  const response = await app.inject({ method: 'POST', url: '/api/proposals', headers: headers(role), payload: input() });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Proposal>();
}
async function action(proposal: Proposal, verb: string, extra: object = {}, role = 'operator') {
  return app.inject({ method: 'POST', url: `/api/proposals/${proposal.id}/${verb}`, headers: headers(role),
    payload: { version: proposal.version, ...extra } });
}
const commercialTables = ['clients', 'internet_plans', 'services', 'payments', 'payment_lines',
  'payment_receipts', 'equipment_catalog', 'stock_movements', 'treasury_movements'];
const businessRows = () => Object.fromEntries(commercialTables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));

test('proposal PDF chooses real A4/A5 dimensions, defaults to A4 and rejects invalid formats without writes', async () => {
  const proposal = await create();
  const before = db.prepare('SELECT total_changes() AS n').get();
  for (const [query, box] of [['', '595.28 841.89'], ['?format=a4', '595.28 841.89'], ['?format=a5', '419.53 595.28']]) {
    const pdf = await app.inject({ url: `/api/proposals/${proposal.id}/proposal.pdf${query}`, headers: headers('operator') });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.rawPayload.toString('latin1')).toContain(`/MediaBox [0 0 ${box}]`);
  }
  for (const query of ['?format=a3', '?format=', '?format=a4&format=a5']) {
    const response = await app.inject({ url: `/api/proposals/${proposal.id}/proposal.pdf${query}`, headers: headers() });
    expect(response.statusCode).toBe(400);
  }
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});

test('UI-shaped draft, edit, issue, delivery, revision and acceptance leave business ledgers unchanged', async () => {
  const before = businessRows();
  let proposal = await create();
  expect(proposal.onceTotalCentavos).toBe(30919);
  const edited = await app.inject({ method: 'PATCH', url: `/api/proposals/${proposal.id}`, headers: headers('operator'),
    payload: { ...input(), title: 'Oferta negociada', version: proposal.version } });
  expect(edited.statusCode, edited.body).toBe(200);
  proposal = edited.json();
  const issued = await action(proposal, 'issue');
  expect(issued.statusCode, issued.body).toBe(200);
  proposal = issued.json();
  expect(proposal.number).toMatch(/^PR-\d{4}-\d{5}$/);
  const delivered = await action(proposal, 'deliver', {
    deliveredAt: '2026-10-13T12:00:00.000Z', channel: 'WhatsApp', note: 'Partilha manual pelo operador'
  });
  expect(delivered.statusCode, delivered.body).toBe(200);
  proposal = delivered.json();
  expect(proposal.deliveries).toHaveLength(1);
  const revision = await action(proposal, 'revise');
  expect(revision.statusCode, revision.body).toBe(200);
  const revised = revision.json<Proposal>();
  const replacement = await action(revised, 'issue');
  expect(replacement.statusCode, replacement.body).toBe(200);
  const accepted = await action(replacement.json(), 'accept', { acceptedBy: 'Ana Lopes, gerente', note: 'Confirmado pessoalmente' });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const final = accepted.json<Proposal>();
  expect(final.chain[0].status).toBe('superseded');
  expect(final.status).toBe('accepted');
  expect(final.allowedActions).toEqual([]);
  const pdf = await app.inject({ url: `/api/proposals/${final.id}/proposal.pdf`, headers: headers('operator') });
  expect(pdf.statusCode, pdf.body).toBe(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');
  expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  expect(businessRows()).toEqual(before);
  expect(db.prepare("SELECT actor_role FROM audit_logs WHERE entity_type='proposal' ORDER BY id DESC LIMIT 1").get()).toEqual({ actor_role: 'operator' });
});

test('all proposal reads, PDF and writes deny technicians and unauthenticated requests', async () => {
  const proposal = await create();
  const urls = ['/api/proposals', `/api/proposals/${proposal.id}`, `/api/proposals/${proposal.id}/proposal.pdf`];
  for (const url of urls) {
    expect((await app.inject({ url, headers: headers('technician') })).statusCode).toBe(403);
    expect((await app.inject({ url })).statusCode).toBe(401);
  }
  for (const verb of ['issue', 'deliver', 'accept', 'refuse', 'cancel', 'revise']) {
    expect((await action(proposal, verb, {}, 'technician')).statusCode).toBe(403);
  }
  expect((await app.inject({ method: 'POST', url: '/api/proposals', headers: headers('technician'), payload: input() })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PATCH', url: `/api/proposals/${proposal.id}`, headers: headers('technician'), payload: { ...input(), version: proposal.version } })).statusCode).toBe(403);
});

test('accepted cancellation requires administrator and preserves acceptance evidence', async () => {
  const draft = await create();
  const issued = await action(draft, 'issue');
  const accepted = await action(issued.json(), 'accept', { acceptedBy: 'Maria Fernandes', note: 'Confirmação assinada' });
  expect(accepted.statusCode).toBe(200);
  const proposal = accepted.json<Proposal>();
  expect((await action(proposal, 'cancel', { reason: 'Acordo revogado' })).statusCode).toBe(403);
  const cancelled = await action(proposal, 'cancel', { reason: 'Acordo revogado' }, 'admin');
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json()).toMatchObject({ status: 'cancelled', acceptedBy: 'Maria Fernandes', decisionNote: 'Confirmação assinada', cancellationReason: 'Acordo revogado' });
});

test('cancelling a draft retains a printable unnumbered record', async () => {
  const proposal = await create();
  const cancelled = await action(proposal, 'cancel', { reason: 'Interessado desistiu' });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json()).toMatchObject({ number: null, status: 'cancelled' });
  const pdf = await app.inject({ url: `/api/proposals/${proposal.id}/proposal.pdf`, headers: headers() });
  expect(pdf.statusCode, pdf.body).toBe(200);
});

test('stale edits conflict while concurrent issue retries recover the same number', async () => {
  const proposal = await create();
  const saved = await app.inject({ method: 'PATCH', url: `/api/proposals/${proposal.id}`, headers: headers(),
    payload: { ...input(), version: proposal.version } });
  expect(saved.statusCode).toBe(200);
  const stale = await app.inject({ method: 'PATCH', url: `/api/proposals/${proposal.id}`, headers: headers(),
    payload: { ...input(), title: 'Stale override', version: proposal.version } });
  expect(stale.statusCode).toBe(409);
  const current = saved.json<Proposal>();
  const [first, retry] = await Promise.all([action(current, 'issue'), action(current, 'issue')]);
  expect(first.statusCode).toBe(200); expect(retry.statusCode).toBe(200);
  expect(retry.json().number).toBe(first.json().number);
});

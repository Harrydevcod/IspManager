import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase, getSqliteDatabase } from '../db/database';
import { clients } from '../db/schema';
import { recordAudit } from '../lib/audit';
import { requireAuth, requireRole } from './auth';

const createClientSchema = z.object({
  fullName: z.string().trim().min(1),
  phone: z.string().trim().optional().nullable(),
  island: z.string().trim().optional().nullable(),
  zone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'suspended', 'cancelled']).default('active')
});

export async function registerClientRoutes(app: FastifyInstance) {
  const canWriteClients = { preHandler: requireRole(['admin', 'operator']) };

  app.get('/api/clients', { preHandler: requireAuth() }, async () => {
    const db = getDatabase();

    return db
      .select()
      .from(clients)
      .orderBy(asc(clients.fullName));
  });

  app.post('/api/clients', canWriteClients, async (request, reply) => {
    const parsed = createClientSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: 'Dados de cliente invalidos' });
    }

    const db = getDatabase();
    const total = await db.$count(clients);
    const clientCode = `CLT-${String(total + 1).padStart(4, '0')}`;
    const now = new Date().toISOString();

    const [client] = await db
      .insert(clients)
      .values({
        clientCode,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone || null,
        island: parsed.data.island || null,
        zone: parsed.data.zone || null,
        address: parsed.data.address || null,
        status: parsed.data.status,
        createdAt: now,
        updatedAt: now
      })
      .returning();

    recordAudit(request, {
      action: 'create',
      entityType: 'client',
      entityId: client.id,
      summary: `Criou cliente ${client.fullName}`,
      metadata: { clientCode: client.clientCode, status: client.status }
    });
    return reply.status(201).send(client);
  });

  app.put('/api/clients/:id', canWriteClients, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = createClientSchema.safeParse(request.body);

    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.status(400).send({ error: 'Dados de cliente invalidos' });
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      const [client] = await db
        .update(clients)
        .set({
          fullName: parsed.data.fullName,
          phone: parsed.data.phone || null,
          island: parsed.data.island || null,
          zone: parsed.data.zone || null,
          address: parsed.data.address || null,
          status: parsed.data.status,
          updatedAt: now
        })
        .where(eq(clients.id, id))
        .returning();

      if (!client) {
        return reply.status(404).send({ error: 'Cliente nao encontrado' });
      }

      recordAudit(request, {
        action: 'update',
        entityType: 'client',
        entityId: client.id,
        summary: `Atualizou cliente ${client.fullName}`,
        metadata: { clientCode: client.clientCode, status: client.status }
      });
      return client;
    } catch {
      return reply.status(409).send({ error: 'Telefone ou NIF ja existe noutro cliente' });
    }
  });

  const bulkRowSchema = z.object({
    fullName: z.string().trim().min(1).max(180),
    clientCode: z.string().trim().max(40).optional().nullable(),
    nif: z.string().trim().regex(/^\d{9}$/).optional().nullable().or(z.literal('').transform(() => null)),
    phone: z.string().trim().max(40).optional().nullable().or(z.literal('').transform(() => null)),
    email: z.string().trim().email().optional().nullable().or(z.literal('').transform(() => null)),
    address: z.string().trim().max(240).optional().nullable(),
    island: z.string().trim().max(80).optional().nullable(),
    zone: z.string().trim().max(120).optional().nullable(),
    status: z.enum(['active', 'suspended', 'cancelled']).default('active')
  });

  const bulkSchema = z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000)
  });

  app.post('/api/clients/bulk', canWriteClients, async (request, reply) => {
    const parsed = bulkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Payload de importacao invalido' });
    }

    const db = getSqliteDatabase();

    const existingCodes = new Set(
      (db.prepare('SELECT client_code FROM clients').all() as Array<{ client_code: string }>).map(
        (row) => row.client_code
      )
    );
    const existingNifs = new Set(
      (db.prepare('SELECT nif FROM clients WHERE nif IS NOT NULL').all() as Array<{ nif: string }>).map(
        (row) => row.nif
      )
    );
    const existingPhones = new Set(
      (
        db
          .prepare('SELECT phone FROM clients WHERE phone IS NOT NULL AND phone <> \'\'')
          .all() as Array<{ phone: string }>
      ).map((row) => row.phone)
    );

    let codeSequence =
      (db.prepare('SELECT COUNT(*) AS n FROM clients').get() as { n: number }).n + 1;

    function nextCode(): string {
      while (existingCodes.has(`CLT-${String(codeSequence).padStart(4, '0')}`)) {
        codeSequence += 1;
      }
      const code = `CLT-${String(codeSequence).padStart(4, '0')}`;
      codeSequence += 1;
      return code;
    }

    const insertStmt = db.prepare(`
      INSERT INTO clients (
        client_code, full_name, phone, email, nif, address,
        island, zone, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);

    const skipped: Array<{ index: number; reason: string; value?: string }> = [];
    const errors: Array<{ index: number; reason: string; detail?: string }> = [];
    const inserted: Array<{ index: number; clientCode: string }> = [];

    const runImport = db.transaction(() => {
      parsed.data.rows.forEach((raw, index) => {
        const rowParsed = bulkRowSchema.safeParse(raw);
        if (!rowParsed.success) {
          errors.push({
            index,
            reason: 'validation',
            detail: rowParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          });
          return;
        }
        const row = rowParsed.data;
        const code = row.clientCode || nextCode();

        if (existingCodes.has(code)) {
          skipped.push({ index, reason: 'clientCode_duplicate', value: code });
          return;
        }
        if (row.nif && existingNifs.has(row.nif)) {
          skipped.push({ index, reason: 'nif_duplicate', value: row.nif });
          return;
        }
        if (row.phone && existingPhones.has(row.phone)) {
          skipped.push({ index, reason: 'phone_duplicate', value: row.phone });
          return;
        }

        try {
          insertStmt.run(
            code,
            row.fullName,
            row.phone || null,
            row.email || null,
            row.nif || null,
            row.address || null,
            row.island || null,
            row.zone || null,
            row.status
          );
        } catch (err) {
          errors.push({
            index,
            reason: 'insert_failed',
            detail: err instanceof Error ? err.message : 'unknown'
          });
          return;
        }

        existingCodes.add(code);
        if (row.nif) existingNifs.add(row.nif);
        if (row.phone) existingPhones.add(row.phone);
        inserted.push({ index, clientCode: code });
      });
    });

    try {
      runImport();
    } catch (err) {
      return reply.status(500).send({
        error: 'Importacao falhou',
        detail: err instanceof Error ? err.message : 'unknown'
      });
    }

    recordAudit(request, {
      action: 'bulk_import',
      entityType: 'client',
      summary: `Importou ${inserted.length} cliente(s)`,
      metadata: {
        received: parsed.data.rows.length,
        inserted: inserted.length,
        skipped: skipped.length,
        errors: errors.length
      }
    });

    return reply.status(200).send({
      summary: {
        received: parsed.data.rows.length,
        inserted: inserted.length,
        skipped: skipped.length,
        errors: errors.length
      },
      inserted,
      skipped,
      errors
    });
  });
}

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator', 'technician'] }).notNull(),
  fullName: text('full_name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

export const clients = sqliteTable('clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientCode: text('client_code').notNull().unique(),
  fullName: text('full_name').notNull(),
  phone: text('phone').unique(),
  email: text('email'),
  nif: text('nif').unique(),
  address: text('address'),
  island: text('island'),
  zone: text('zone'),
  status: text('status', { enum: ['active', 'suspended', 'cancelled'] }).notNull().default('active'),
  notes: text('notes'),
  admissionDate: text('admission_date'),
  defaultPaymentMethod: text('default_payment_method', { enum: ['numerario', 'transferencia', 'outro'] }),
  whatsappOptOut: integer('whatsapp_opt_out', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP')
});

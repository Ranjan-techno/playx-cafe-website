import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Same approach as migration-007.test.ts: no Postgres here, so pin 008's invariants textually.
const root = path.join(__dirname, '../../..');
const raw = readFileSync(path.join(root, 'database/migrations/008_booking_notifications.sql'), 'utf8');
const sql = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('008: additive only — one CREATE TABLE and one CREATE INDEX, nothing else', () => {
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS booking_notifications \(/);
  assert.match(statements[1], /^CREATE INDEX IF NOT EXISTS idx_booking_notifications_pending_due ON booking_notifications \(next_attempt_at\) WHERE status = 'pending'$/);
  assert.ok(statements.every((s) => s.startsWith('CREATE ')), 'every statement is a CREATE');
  assert.doesNotMatch(sql.replace(/ON DELETE RESTRICT/g, ''), /\b(ALTER|DROP|UPDATE|DELETE|INSERT|TRUNCATE)\b/i, 'no existing table or row is touched');
});

test('008: no backfill — existing confirmed bookings (e.g. #1033/#1034) get no notification row', () => {
  assert.doesNotMatch(sql, /INSERT INTO booking_notifications/i);
  assert.match(raw, /EXISTING BOOKINGS ARE NOT BACKFILLED/);
});

test('008: durable idempotency — UNIQUE (booking_id, notification_type), FK to bookings, constrained type/status', () => {
  assert.match(sql, /CONSTRAINT booking_notifications_booking_type_unique UNIQUE \(booking_id, notification_type\)/);
  assert.match(sql, /booking_id UUID NOT NULL REFERENCES bookings \(id\) ON DELETE RESTRICT/);
  assert.match(sql, /CHECK \(notification_type IN \('BOOKING_CONFIRMED'\)\)/);
  assert.match(sql, /CHECK \(status IN \('pending', 'sent', 'failed', 'suppressed'\)\)/);
  for (const column of ['recipient_email TEXT', 'attempt_count INTEGER NOT NULL DEFAULT 0', 'next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()', 'last_attempt_at TIMESTAMPTZ', 'sent_at TIMESTAMPTZ', 'created_at TIMESTAMPTZ NOT NULL DEFAULT now()', 'updated_at TIMESTAMPTZ NOT NULL DEFAULT now()']) {
    assert.ok(sql.includes(column), `missing column: ${column}`);
  }
});

test('008: registered with the migration runner, last, after 007 (8 migrations in total)', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  assert.match(handler, /import schema008 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/008_booking_notifications\.sql';/);
  const i007 = handler.indexOf("filename: '007_enforce_payment_environment.sql', sql: schema007");
  const i008 = handler.indexOf("filename: '008_booking_notifications.sql', sql: schema008");
  assert.ok(i007 > 0 && i008 > i007);
  assert.equal(handler.match(/filename: '/g)?.length, 8);
});

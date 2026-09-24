import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The migration can't run without Postgres here, so pin its invariants textually, and mirror the
// backfill/CHECK semantics in tiny functions checked against the SQL text so the two can't drift.
const root = path.join(__dirname, '../../..');
const sql = readFileSync(path.join(root, 'database/migrations/006_payment_environment_expansion.sql'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ');

const ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'];

test('006: adds bookings.booking_environment and payments.payment_environment as plain TEXT columns', () => {
  assert.match(sql, /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_environment TEXT CONSTRAINT bookings_booking_environment_chk CHECK/);
  assert.match(sql, /ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_environment TEXT CONSTRAINT payments_payment_environment_chk CHECK/);
});

test('006 EXPAND: both columns stay nullable and have no DEFAULT', () => {
  assert.doesNotMatch(sql, /NOT NULL/i);
  assert.doesNotMatch(sql, /DEFAULT/i);
  assert.doesNotMatch(sql, /ALTER COLUMN/i);
});

test('006: CHECK constraints allow only SANDBOX/PRODUCTION when a value is supplied (NULL still allowed)', () => {
  assert.match(sql, /CHECK \(booking_environment IN \('SANDBOX', 'PRODUCTION'\)\)/);
  assert.match(sql, /CHECK \(payment_environment IN \('SANDBOX', 'PRODUCTION'\)\)/);
  // SQL CHECK semantics: a row is rejected only when the expression is FALSE; NULL IN (...) is
  // NULL (unknown), so the currently deployed Lambdas' NULL inserts keep passing.
  const check = (value: string | null) => value === null || ENVIRONMENTS.includes(value);
  assert.equal(check('SANDBOX'), true);
  assert.equal(check('PRODUCTION'), true);
  assert.equal(check(null), true);
  assert.equal(check('sandbox'), false);
  assert.equal(check('STAGING'), false);
  assert.equal(check(''), false);
});

test('006 backfill: every existing booking becomes SANDBOX, and nothing is set to PRODUCTION', () => {
  assert.match(sql, /UPDATE bookings SET booking_environment = 'SANDBOX' WHERE booking_environment IS NULL;/);
  const bookingUpdate = sql.match(/UPDATE bookings [^;]*;/)?.[0] ?? '';
  assert.doesNotMatch(bookingUpdate, /PRODUCTION/);
  const backfill = (row: { booking_environment: string | null }) =>
    row.booking_environment === null ? { ...row, booking_environment: 'SANDBOX' } : row;
  assert.equal(backfill({ booking_environment: null }).booking_environment, 'SANDBOX');
});

test('006 backfill: explicit PRODUCTION payments stay PRODUCTION; SANDBOX/missing/NULL metadata become SANDBOX', () => {
  assert.match(
    sql,
    /UPDATE payments SET payment_environment = CASE WHEN metadata ->> 'paymentEnvironment' = 'PRODUCTION' THEN 'PRODUCTION' ELSE 'SANDBOX' END WHERE payment_environment IS NULL;/,
  );
  const backfill = (metadata: Record<string, unknown> | null) =>
    metadata?.paymentEnvironment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
  assert.equal(backfill({ paymentEnvironment: 'PRODUCTION' }), 'PRODUCTION');
  assert.equal(backfill({ paymentEnvironment: 'SANDBOX' }), 'SANDBOX');
  assert.equal(backfill({ environment: 'SANDBOX' }), 'SANDBOX');
  assert.equal(backfill({}), 'SANDBOX');
  assert.equal(backfill(null), 'SANDBOX');
  assert.equal(backfill({ paymentEnvironment: 'production' }), 'SANDBOX');
});

test('006: backfills only touch NULL rows, so a re-run never overwrites a value', () => {
  const updates = sql.match(/UPDATE [^;]*;/g) ?? [];
  assert.equal(updates.length, 2);
  for (const u of updates) assert.match(u, /WHERE (booking|payment)_environment IS NULL;$/);
});

test('006: indexes booking_environment and adds an environment-aware reconciliation index', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_bookings_booking_environment ON bookings \(booking_environment\);/);
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_payments_open_for_reconciliation_by_env ON payments \(payment_environment, created_at\) WHERE payment_status IN \('created', 'pending'\);/,
  );
});

test('006: the environment-blind idx_payments_open_for_reconciliation is NOT dropped (or touched)', () => {
  assert.doesNotMatch(sql, /DROP/i);
  assert.doesNotMatch(sql, /idx_payments_open_for_reconciliation[^_]/);
  const m005 = readFileSync(path.join(root, 'database/migrations/005_duplicate_payment_recording.sql'), 'utf8');
  assert.match(m005, /CREATE INDEX idx_payments_open_for_reconciliation\s+ON payments \(created_at\)/);
});

test('006: is registered with the migration runner, after 005', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  const i005 = handler.indexOf("filename: '005_duplicate_payment_recording.sql'");
  const i006 = handler.indexOf("filename: '006_payment_environment_expansion.sql', sql: schema006");
  assert.ok(i005 > 0 && i006 > i005);
  assert.match(handler, /import schema006 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/006_payment_environment_expansion\.sql';/);
});

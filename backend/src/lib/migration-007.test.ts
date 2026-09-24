import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Same approach as migration-006.test.ts: no Postgres here, so pin the migration's invariants
// textually and mirror the backfill/NOT NULL semantics in tiny functions checked against the SQL.
const root = path.join(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, 'database/migrations', file), 'utf8');
const stripComments = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');
const sql = stripComments(read('007_enforce_payment_environment.sql'));
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('007: consists of exactly the two backfills, the two SET NOT NULLs and the one index drop, in that order', () => {
  assert.deepEqual(statements, [
    "UPDATE bookings SET booking_environment = 'SANDBOX' WHERE booking_environment IS NULL",
    'ALTER TABLE bookings ALTER COLUMN booking_environment SET NOT NULL',
    "UPDATE payments SET payment_environment = 'SANDBOX' WHERE payment_environment IS NULL",
    'ALTER TABLE payments ALTER COLUMN payment_environment SET NOT NULL',
    'DROP INDEX IF EXISTS idx_payments_open_for_reconciliation',
  ]);
});

test('007 backfill: NULL bookings become SANDBOX before NOT NULL is set; existing values are untouched', () => {
  const backfill = sql.indexOf("UPDATE bookings SET booking_environment = 'SANDBOX' WHERE booking_environment IS NULL;");
  const enforce = sql.indexOf('ALTER TABLE bookings ALTER COLUMN booking_environment SET NOT NULL;');
  assert.ok(backfill >= 0 && enforce > backfill);
  const apply = (value: string | null) => (value === null ? 'SANDBOX' : value);
  assert.equal(apply(null), 'SANDBOX');
  assert.equal(apply('SANDBOX'), 'SANDBOX');
  assert.equal(apply('PRODUCTION'), 'PRODUCTION');
});

test('007 backfill: NULL payments become SANDBOX before NOT NULL is set; existing values are untouched', () => {
  const backfill = sql.indexOf("UPDATE payments SET payment_environment = 'SANDBOX' WHERE payment_environment IS NULL;");
  const enforce = sql.indexOf('ALTER TABLE payments ALTER COLUMN payment_environment SET NOT NULL;');
  assert.ok(backfill >= 0 && enforce > backfill);
  const apply = (value: string | null) => (value === null ? 'SANDBOX' : value);
  assert.equal(apply(null), 'SANDBOX');
  assert.equal(apply('PRODUCTION'), 'PRODUCTION');
});

test('007 backfill: never writes PRODUCTION and only touches NULL rows', () => {
  const updates = sql.match(/UPDATE [^;]*;/g) ?? [];
  assert.equal(updates.length, 2);
  for (const u of updates) {
    assert.doesNotMatch(u, /PRODUCTION/);
    assert.match(u, /WHERE (booking|payment)_environment IS NULL;$/);
  }
});

test('007: sets booking_environment and payment_environment NOT NULL', () => {
  assert.match(sql, /ALTER TABLE bookings ALTER COLUMN booking_environment SET NOT NULL;/);
  assert.match(sql, /ALTER TABLE payments ALTER COLUMN payment_environment SET NOT NULL;/);
});

test('007: adds no DEFAULT to either column (006 added none either)', () => {
  assert.doesNotMatch(sql, /DEFAULT/i);
  assert.doesNotMatch(stripComments(read('006_payment_environment_expansion.sql')), /DEFAULT/i);
});

test("007: does not recreate, drop or otherwise touch 006's CHECK constraints", () => {
  assert.doesNotMatch(sql, /CONSTRAINT/i);
  assert.doesNotMatch(sql, /CHECK/i);
  assert.doesNotMatch(sql, /_chk/);
  assert.doesNotMatch(sql, /ADD COLUMN|DROP COLUMN|TYPE /i);
  const m006 = stripComments(read('006_payment_environment_expansion.sql'));
  assert.match(m006, /CONSTRAINT bookings_booking_environment_chk CHECK \(booking_environment IN \('SANDBOX', 'PRODUCTION'\)\)/);
  assert.match(m006, /CONSTRAINT payments_payment_environment_chk CHECK \(payment_environment IN \('SANDBOX', 'PRODUCTION'\)\)/);
});

test('007: drops the environment-blind idx_payments_open_for_reconciliation (005) and nothing else', () => {
  const drops = sql.match(/DROP [^;]*;/gi) ?? [];
  assert.deepEqual(drops, ['DROP INDEX IF EXISTS idx_payments_open_for_reconciliation;']);
  assert.match(read('005_duplicate_payment_recording.sql'), /CREATE INDEX idx_payments_open_for_reconciliation\s+ON payments \(created_at\)/);
});

test('007: keeps the environment-aware idx_payments_open_for_reconciliation_by_env (006)', () => {
  assert.doesNotMatch(sql, /idx_payments_open_for_reconciliation_by_env/);
  assert.doesNotMatch(sql, /CREATE INDEX/i);
  assert.match(
    stripComments(read('006_payment_environment_expansion.sql')),
    /CREATE INDEX IF NOT EXISTS idx_payments_open_for_reconciliation_by_env ON payments \(payment_environment, created_at\) WHERE payment_status IN \('created', 'pending'\);/,
  );
});

test('007: migrations 001-006 are byte-for-byte unchanged (they are already applied in AWS)', () => {
  const pinned: Record<string, string> = {
    '001_initial_schema.sql': '50c9faf5f1e4d316d5cdf5c1aec9c155e4e43631716d4b635abe18e8c8487847',
    '002_simulator_inventory.sql': '196a16b5e3083b48a5181b3e29e847b6ff69fccdeec95766d84916c57abb25e1',
    '003_payment_foundation.sql': 'c7740cbd18e31a1a9e222e3e21211fe825eaf872ec69fc5fdb484eb5b63f5c4a',
    '004_short_booking_number.sql': '12221cf9968fdc5a1306c11bacbf05fa42846c1df12e56b717eb4385966e3c9d',
    '005_duplicate_payment_recording.sql': '5957594b543e4d81ffe5d5b966324935e15f4c0bb350c8715198b29f3d3d62f2',
    '006_payment_environment_expansion.sql': '17b186adbca8452fcbd1a4e0207990dea6dd325803e63af82edbe2f75b61ff90',
  };
  for (const [file, sha256] of Object.entries(pinned)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(root, 'database/migrations', file))).digest('hex'), sha256, file);
  }
});

test('007: is registered with the migration runner, after 006, with 001-006 still in order', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  assert.match(handler, /import schema007 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/007_enforce_payment_environment\.sql';/);
  const order = [
    "filename: '001_initial_schema.sql', sql: schema001",
    "filename: '002_simulator_inventory.sql', sql: schema002",
    "filename: '003_payment_foundation.sql', sql: schema003",
    "filename: '004_short_booking_number.sql', sql: schema004",
    "filename: '005_duplicate_payment_recording.sql', sql: schema005",
    "filename: '006_payment_environment_expansion.sql', sql: schema006",
    "filename: '007_enforce_payment_environment.sql', sql: schema007",
  ].map((entry) => handler.indexOf(entry));
  assert.ok(order.every((i) => i > 0), 'every migration is registered');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'registered in filename order');
  // Later migrations (008+) append after 007; migration-008.test.ts pins the current total.
  assert.ok((handler.match(/filename: '/g)?.length ?? 0) >= 7);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Short booking number: database/migrations/004_short_booking_number.sql is the actual, only
// source of truth for how bookings.booking_number is generated/backfilled — there's no real
// Postgres available to run it against in this repo (see backend/src/lib/test-support/fake-db.ts's
// header, same reasoning applies here), so unlike the fake-DB-backed tests that exercise real
// production TypeScript against an in-memory model, this reads the migration file itself and
// asserts on its text — a regression test for the specific, load-bearing SQL decisions the CLAUDE.md
// architecture and this feature's brief require, so an edit that quietly drops one of them (the
// starting value, the uniqueness guarantee, the oldest-first backfill order, the range guard) fails
// loudly here instead of only being caught by a human re-reading the diff.

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../database/migrations/004_short_booking_number.sql'),
  'utf8',
);

test('booking_number_seq starts at 1001 and is bounded to the 4-digit range, non-cycling', () => {
  assert.match(MIGRATION_SQL, /CREATE SEQUENCE booking_number_seq/);
  assert.match(MIGRATION_SQL, /START WITH 1001/);
  assert.match(MIGRATION_SQL, /MINVALUE 1001/);
  assert.match(MIGRATION_SQL, /MAXVALUE 9999/);
  assert.match(MIGRATION_SQL, /NO CYCLE/);
});

test('booking_number is added as a plain column, never replacing or renumbering the UUID primary key', () => {
  assert.match(MIGRATION_SQL, /ALTER TABLE bookings ADD COLUMN booking_number INTEGER/);
  // The real internal identifier is never touched by this migration — no ALTER/UPDATE of `id`
  // anywhere in the file (the backfill's own `WHERE b.id = ordered.id` only ever *reads* id to
  // find the matching row; it's never the column being SET).
  assert.doesNotMatch(MIGRATION_SQL, /ALTER TABLE bookings[^;]*\bDROP COLUMN id\b/i);
  assert.doesNotMatch(MIGRATION_SQL, /\bSET\s+id\s*=/i);
});

test('existing bookings are backfilled deterministically, oldest first by created_at then id', () => {
  assert.match(MIGRATION_SQL, /ROW_NUMBER\(\)\s*OVER\s*\(\s*ORDER BY created_at ASC, id ASC\s*\)/);
  // The backfill formula: booking_number = 1000 + row_number(), so the very first booking
  // (row_number = 1) gets exactly 1001, matching the sequence's own starting value.
  assert.match(MIGRATION_SQL, /SET booking_number = 1000 \+ ordered\.rn/);
});

test('new bookings get their number from the sequence automatically — never supplied by the client', () => {
  assert.match(MIGRATION_SQL, /ALTER TABLE bookings ALTER COLUMN booking_number SET DEFAULT nextval\('booking_number_seq'\)/);
});

test('booking_number is enforced NOT NULL, range-checked, and unique — by the schema, not just the sequence', () => {
  assert.match(MIGRATION_SQL, /ALTER TABLE bookings ALTER COLUMN booking_number SET NOT NULL/);
  assert.match(MIGRATION_SQL, /CHECK \(booking_number BETWEEN 1001 AND 9999\)/);
  assert.match(MIGRATION_SQL, /CREATE UNIQUE INDEX idx_bookings_booking_number_unique ON bookings \(booking_number\)/);
});

test('the migration refuses to run if backfilling would already exceed the 4-digit range, before touching any schema', () => {
  const guardIndex = MIGRATION_SQL.indexOf('RAISE EXCEPTION');
  const sequenceIndex = MIGRATION_SQL.indexOf('CREATE SEQUENCE booking_number_seq');
  assert.ok(guardIndex > -1, 'expected a RAISE EXCEPTION guard');
  assert.ok(sequenceIndex > -1, 'expected the booking_number_seq sequence to be created');
  // The guard must run before any schema-changing statement, so a migration that would overflow
  // the range fails clearly instead of partway through the backfill/constraints below.
  assert.ok(guardIndex < sequenceIndex, 'the range guard must run before any schema change');
  assert.match(MIGRATION_SQL, /existing_count > 8999/);
});

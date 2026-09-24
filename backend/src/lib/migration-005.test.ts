import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The migration can't run without Postgres here, so pin its invariants textually.
const sql = readFileSync(path.join(__dirname, '../../../database/migrations/005_duplicate_payment_recording.sql'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ');

test('005: the primary-payment unique index keeps a REFUNDED primary in its slot', () => {
  assert.match(sql, /CREATE UNIQUE INDEX idx_payments_one_paid_per_booking ON payments \(booking_id\) WHERE payment_status IN \('paid', 'refunded'\) AND duplicate_of_payment_id IS NULL;/);
});

test('005: a payment cannot be a duplicate of itself, and no trigger is used', () => {
  assert.match(sql, /CHECK \(duplicate_of_payment_id IS NULL OR duplicate_of_payment_id <> id\)/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(TRIGGER|FUNCTION)/i);
});

// A tiny mirror of the backfill's semantics, checked against the SQL text so the two can't drift:
// PhonePe rows only, and only rows that do not already carry the key.
test('005 backfill: legacy PhonePe rows become SANDBOX; an existing explicit paymentEnvironment is never overwritten', () => {
  assert.match(
    sql,
    /UPDATE payments SET metadata = COALESCE\(metadata, '\{\}'::jsonb\) \|\| '\{"paymentEnvironment": "SANDBOX"\}'::jsonb WHERE provider = 'phonepe' AND \(metadata IS NULL OR NOT \(metadata \? 'paymentEnvironment'\)\);/,
  );
  const backfill = (row: { provider: string; metadata: Record<string, unknown> | null }) =>
    row.provider === 'phonepe' && (row.metadata === null || !('paymentEnvironment' in row.metadata))
      ? { ...row, metadata: { ...(row.metadata ?? {}), paymentEnvironment: 'SANDBOX' } }
      : row;
  assert.equal(backfill({ provider: 'phonepe', metadata: { environment: 'SANDBOX' } }).metadata?.paymentEnvironment, 'SANDBOX');
  assert.equal(backfill({ provider: 'phonepe', metadata: null }).metadata?.paymentEnvironment, 'SANDBOX');
  assert.equal(backfill({ provider: 'phonepe', metadata: { paymentEnvironment: 'PRODUCTION' } }).metadata?.paymentEnvironment, 'PRODUCTION');
  assert.equal(backfill({ provider: 'mock', metadata: {} }).metadata?.paymentEnvironment, undefined);
});

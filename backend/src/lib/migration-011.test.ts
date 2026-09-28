import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Same approach as migration-008/009.test.ts: no Postgres here, so pin 011's invariants textually.
const root = path.join(__dirname, '../../..');
const raw = readFileSync(path.join(root, 'database/migrations/011_walk_in_bookings.sql'), 'utf8');
const sql = raw
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('011: additive only — ALTER TABLE bookings/payments, no data rewrite, no DROP of anything but cognito_sub NOT NULL', () => {
  assert.ok(statements.length > 0);
  assert.ok(
    statements.every((s) => /^ALTER TABLE (bookings|payments) /.test(s)),
    `only bookings/payments are altered: ${statements.join(' | ')}`,
  );
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|INSERT|TRUNCATE|RENAME|DROP (TABLE|COLUMN|CONSTRAINT|INDEX|TYPE))\b/i, 'no row or object removed/rewritten');
  const drops = sql.match(/DROP NOT NULL/g) ?? [];
  assert.equal(drops.length, 1);
  assert.match(sql, /ALTER TABLE bookings ALTER COLUMN cognito_sub DROP NOT NULL/);
  assert.doesNotMatch(sql, /\b(booking_allocations|simulators|products|booking_notifications)\b/, 'no other table');
  assert.doesNotMatch(sql, /ALTER TYPE/, 'the enum label is 010’s job');
});

test('011: bookings.booking_source defaults existing rows to ONLINE; only ONLINE/WALK_IN allowed', () => {
  assert.match(
    sql,
    /ADD COLUMN booking_source TEXT NOT NULL DEFAULT 'ONLINE' CONSTRAINT bookings_booking_source_chk CHECK \(booking_source IN \('ONLINE', 'WALK_IN'\)\)/,
  );
  // The only DEFAULT in the file: new columns other than booking_source stay NULL for old rows.
  assert.equal(sql.match(/DEFAULT/g)?.length, 1);
  assert.match(sql, /ADD COLUMN created_by_admin_sub TEXT;?/);
  assert.doesNotMatch(sql, /created_by_admin_sub TEXT NOT NULL/);
});

test('011: bookings_source_identity_chk — ONLINE keeps Cognito ownership; WALK_IN has no sub, an admin, name and phone', () => {
  const chk = /ADD CONSTRAINT bookings_source_identity_chk CHECK \((.*)\)$/.exec(
    statements.find((s) => s.includes('bookings_source_identity_chk')) ?? '',
  );
  assert.ok(chk, 'constraint present');
  const body = chk[1].replace(/\s+/g, ' ');
  assert.match(body, /\( booking_source = 'ONLINE' AND cognito_sub IS NOT NULL AND created_by_admin_sub IS NULL \)/);
  assert.match(
    body,
    /\( booking_source = 'WALK_IN' AND cognito_sub IS NULL AND created_by_admin_sub IS NOT NULL AND customer_name IS NOT NULL AND customer_phone IS NOT NULL \)/,
  );
  assert.match(body, /\) OR \(/);
  // customer_email is optional for walk-ins.
  assert.doesNotMatch(body, /customer_email/);
});

test('011: payments.payment_method + counter constraints; phonepe/mock rows keep NULL', () => {
  assert.match(
    sql,
    /ADD COLUMN payment_method TEXT CONSTRAINT payments_payment_method_chk CHECK \(payment_method IN \('CASH', 'UPI', 'CARD', 'COMPLIMENTARY'\)\)/,
  );
  assert.match(sql, /payments_counter_method_chk CHECK \(\(provider = 'counter'\) = \(payment_method IS NOT NULL\)\)/);
  assert.match(sql, /payments_counter_final_chk CHECK \(provider <> 'counter' OR payment_status IN \('paid', 'refunded'\)\)/);
  assert.match(sql, /payments_complimentary_zero_chk CHECK \(payment_method IS DISTINCT FROM 'COMPLIMENTARY' OR amount_inr = 0\)/);
  assert.doesNotMatch(sql, /payment_method TEXT NOT NULL/);
});

test('011: registered last, after 010 (11 migrations in total)', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  assert.match(handler, /import schema011 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/011_walk_in_bookings\.sql';/);
  const i010 = handler.indexOf("filename: '010_counter_payment_provider.sql', sql: schema010");
  const i011 = handler.indexOf("filename: '011_walk_in_bookings.sql', sql: schema011");
  assert.ok(i010 > 0 && i011 > i010);
  assert.equal(handler.match(/filename: '/g)?.length, 11);
  assert.equal(handler.lastIndexOf("filename: '"), i011, '011 is the last entry');
});

test('011: migrations 001-009 are unchanged by Stage 3A.1 (git blob check)', () => {
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'database/migrations'], { cwd: root, encoding: 'utf8' });
  } catch {
    return; // not a git checkout — nothing to compare against
  }
  assert.deepEqual(diff.split('\n').filter(Boolean), []);
});

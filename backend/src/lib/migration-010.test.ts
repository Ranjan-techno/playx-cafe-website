import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Same approach as migration-008/009.test.ts: no Postgres here, so pin 010's invariants textually.
const root = path.join(__dirname, '../../..');
const raw = readFileSync(path.join(root, 'database/migrations/010_counter_payment_provider.sql'), 'utf8');
const sql = raw
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test("010: exactly one statement — ALTER TYPE payment_provider ADD VALUE IF NOT EXISTS 'counter'", () => {
  assert.deepEqual(statements, ["ALTER TYPE payment_provider ADD VALUE IF NOT EXISTS 'counter'"]);
});

test('010: nothing uses the new label in the same migration (it must commit first)', () => {
  // Any CHECK/INSERT/comparison mentioning 'counter' belongs in 011, never here.
  assert.equal(sql.match(/'counter'/g)?.length, 1);
  assert.doesNotMatch(sql, /\b(CREATE|DROP|UPDATE|DELETE|INSERT|TRUNCATE|RENAME|ALTER TABLE|CONSTRAINT|CHECK)\b/i);
  assert.match(raw, /cannot be USED/);
});

test('010: registered with the migration runner immediately after 009 and before 011', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  assert.match(handler, /import schema010 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/010_counter_payment_provider\.sql';/);
  const i009 = handler.indexOf("filename: '009_booking_notification_delivery.sql', sql: schema009");
  const i010 = handler.indexOf("filename: '010_counter_payment_provider.sql', sql: schema010");
  const i011 = handler.indexOf("filename: '011_walk_in_bookings.sql', sql: schema011");
  assert.ok(i009 > 0 && i010 > i009 && i011 > i010);
  const between = handler.slice(i009, i010);
  assert.equal(between.match(/filename: '/g)?.length, 1, 'no other migration between 009 and 010');
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Same approach as migration-008.test.ts: no Postgres here, so pin 009's invariants textually.
const root = path.join(__dirname, '../../..');
const raw = readFileSync(path.join(root, 'database/migrations/009_booking_notification_delivery.sql'), 'utf8');
const sql = raw
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

test('009: additive only — ALTER TABLE booking_notifications ADD COLUMN / ADD CONSTRAINT, nothing else', () => {
  assert.equal(statements.length, 2);
  assert.ok(statements.every((s) => s.startsWith('ALTER TABLE booking_notifications ADD ')), 'only booking_notifications is altered');
  const actions = statements.flatMap((s) => s.replace(/^ALTER TABLE booking_notifications /, '').split(/,\s*(?=ADD )/));
  assert.ok(actions.every((a) => /^ADD (COLUMN IF NOT EXISTS|CONSTRAINT) /.test(a)), `only ADDs: ${actions.join(' | ')}`);
  assert.doesNotMatch(sql, /\b(DROP|UPDATE|DELETE|INSERT|TRUNCATE|RENAME|ALTER COLUMN|SET DEFAULT|SET NOT NULL|NOT NULL|DEFAULT)\b/i, 'no existing column/row touched; new columns nullable, no DEFAULT');
  assert.doesNotMatch(sql, /\b(bookings|payments|booking_allocations)\b/, 'no other table');
});

test('009: the delivery columns exist with constrained values', () => {
  for (const column of [
    'delivery_status TEXT',
    'last_delivery_event_at TIMESTAMPTZ',
    'delivered_at TIMESTAMPTZ',
    'bounced_at TIMESTAMPTZ',
    'complained_at TIMESTAMPTZ',
    'delivery_failure_type TEXT',
    'delivery_failure_subtype TEXT',
  ]) {
    assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${column}`), `missing column: ${column}`);
  }
  assert.match(sql, /CHECK \( delivery_status IS NULL OR delivery_status IN \('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'rejected', 'rendering_failed'\) \)/);
  assert.match(sql, /booking_notifications_delivery_requires_sent_chk CHECK \(delivery_status IS NULL OR status = 'sent'\)/, 'delivery evidence only for sent rows');
  assert.match(sql, /delivery_failure_type IS NULL OR delivery_failure_type ~ '\^\[A-Za-z0-9 _\.-\]\{1,64\}\$'/);
  assert.match(sql, /delivery_failure_subtype IS NULL OR delivery_failure_subtype ~ '\^\[A-Za-z0-9 _\.-\]\{1,64\}\$'/);
  // The outbox status constraint from 008 is not redefined: pending/sent/failed/suppressed stays independent.
  assert.doesNotMatch(sql, /booking_notifications_status_chk/);
});

test('009: no backfill — old SENT rows stay delivery_status NULL (never claimed delivered)', () => {
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /DEFAULT/i, 'no DEFAULT could stamp existing rows');
  assert.match(raw, /NO BACKFILL/);
});

test('009: registered with the migration runner, after 008 (later stages append after it)', () => {
  const handler = readFileSync(path.join(root, 'infra/lib/lambda/migrate/handler.ts'), 'utf8');
  assert.match(handler, /import schema009 from '\.\.\/\.\.\/\.\.\/\.\.\/database\/migrations\/009_booking_notification_delivery\.sql';/);
  const i008 = handler.indexOf("filename: '008_booking_notifications.sql', sql: schema008");
  const i009 = handler.indexOf("filename: '009_booking_notification_delivery.sql', sql: schema009");
  assert.ok(i008 > 0 && i009 > i008);
  // Stage 3A.1 appended 010/011 after it; the "latest entry / total count" pin lives in
  // migration-011.test.ts now.
  const i010 = handler.indexOf("filename: '010_counter_payment_provider.sql', sql: schema010");
  assert.ok(i010 > i009, '009 precedes 010');
});

test('009: migrations 001-008 are unchanged by Stage 2G (git blob check)', () => {
  // The files 001-008 must be byte-identical to the committed versions.
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'database/migrations'], { cwd: root, encoding: 'utf8' });
  } catch {
    return; // not a git checkout (e.g. a packaged build) — nothing to compare against
  }
  const changed = diff.split('\n').filter(Boolean);
  assert.deepEqual(changed.filter((f) => !/009_/.test(f)), []);
});

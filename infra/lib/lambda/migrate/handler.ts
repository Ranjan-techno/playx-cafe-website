// One-off Play X schema migration runner (Story 2.3).
//
// Deployed by CDK (infra/lib/constructs/migration.ts) but never invoked by CDK, an
// EventBridge rule, or an API — it sits idle in the VPC until a human runs, e.g.:
//
//   aws lambda invoke --function-name playx-dev-migrate --profile playx-dev out.json
//
// which requires that caller to hold lambda:InvokeFunction on this function specifically.
// Running from inside the VPC (see migration.ts) is what lets it reach the database at all —
// the DB's security group only accepts 5432 from the lambda security group this function runs
// in, and the DB has no public endpoint.
//
// Each migration file is applied at most once (tracked in `schema_migrations`) and inside its
// own transaction, so a failure partway through never leaves a half-applied file committed.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import schema001 from '../../../../database/migrations/001_initial_schema.sql';
import schema002 from '../../../../database/migrations/002_simulator_inventory.sql';
import schema003 from '../../../../database/migrations/003_payment_foundation.sql';
import schema004 from '../../../../database/migrations/004_short_booking_number.sql';
import schema005 from '../../../../database/migrations/005_duplicate_payment_recording.sql';
import schema006 from '../../../../database/migrations/006_payment_environment_expansion.sql';
import schema007 from '../../../../database/migrations/007_enforce_payment_environment.sql';
import schema008 from '../../../../database/migrations/008_booking_notifications.sql';

interface Migration {
  filename: string;
  sql: string;
}

// Add a new migration by adding the file under database/migrations/, importing it above, and
// appending it here — in filename order.
const MIGRATIONS: Migration[] = [
  { filename: '001_initial_schema.sql', sql: schema001 },
  // Phase 2: simulator inventory + booking_allocations (see the file's own header for why this
  // is non-destructive — additive only, no ALTER/DROP on 001's tables).
  { filename: '002_simulator_inventory.sql', sql: schema002 },
  // Phase 3A: payment foundation — the `payments` table (see the file's own header for the
  // backward-compatibility decisions this migration makes, additive only).
  { filename: '003_payment_foundation.sql', sql: schema003 },
  // Short booking number: adds bookings.booking_number (4-digit, 1001-9999) — see the file's own
  // header for the sequence/backfill/constraint approach, additive only.
  { filename: '004_short_booking_number.sql', sql: schema004 },
  // Duplicate-payment recording: narrows the one-paid-per-booking unique index to primary payments
  // and adds payments.duplicate_of_payment_id — see the file's own header.
  { filename: '005_duplicate_payment_recording.sql', sql: schema005 },
  // Payment environment EXPAND step: nullable, no-DEFAULT bookings.booking_environment and
  // payments.payment_environment, backfilled, plus an environment-aware reconciliation index —
  // see the file's own header for the EXPAND -> CODE -> ENFORCE rollout.
  { filename: '006_payment_environment_expansion.sql', sql: schema006 },
  // Payment environment ENFORCE step: backfills remaining NULLs to SANDBOX, sets both columns
  // NOT NULL (still no DEFAULT) and drops 005's environment-blind reconciliation index — see the
  // file's own header. Apply only after the Stage 1B code is deployed and verified.
  { filename: '007_enforce_payment_environment.sql', sql: schema007 },
  // Stage 2F: booking_notifications — the per-booking outbox for the booking-confirmation email
  // (UNIQUE booking_id + notification_type). Additive only, no backfill: bookings confirmed before
  // it (e.g. #1033/#1034) are never emailed — see the file's own header.
  { filename: '008_booking_notifications.sql', sql: schema008 },
];

interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

async function loadDbSecret(secretArn: string): Promise<DbSecret> {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }
  return JSON.parse(response.SecretString) as DbSecret;
}

export const handler = async () => {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DB_SECRET_ARN environment variable is not set');
  }

  const creds = await loadDbSecret(secretArn);
  const db = new Client({
    host: creds.host,
    port: creds.port,
    database: creds.dbname,
    user: creds.username,
    password: creds.password,
    // Encrypts the connection. Not verifying the RDS CA chain here is an accepted trade-off:
    // this connection never leaves the isolated VPC subnet the DB's security group is scoped
    // to. Revisit (bundle the RDS CA bundle, set rejectUnauthorized: true) if that changes.
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.filename));

    const results: { filename: string; status: 'applied' | 'skipped' }[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.filename)) {
        results.push({ filename: migration.filename, status: 'skipped' });
        continue;
      }

      await db.query('BEGIN');
      try {
        await db.query(migration.sql);
        await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [migration.filename]);
        await db.query('COMMIT');
        results.push({ filename: migration.filename, status: 'applied' });
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    }

    return { results };
  } finally {
    await db.end();
  }
};

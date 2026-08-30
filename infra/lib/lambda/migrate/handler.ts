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

interface Migration {
  filename: string;
  sql: string;
}

// Add a new migration by adding the file under database/migrations/, importing it above, and
// appending it here — in filename order.
const MIGRATIONS: Migration[] = [{ filename: '001_initial_schema.sql', sql: schema001 }];

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

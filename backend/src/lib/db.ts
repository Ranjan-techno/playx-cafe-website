import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

// Story 2.6: a reusable PostgreSQL connection for the products/booking Lambdas.
//
// Unlike infra/lib/lambda/migrate/handler.ts (a one-off script that connects, runs, and always
// calls db.end()), these are request/response Lambdas invoked repeatedly — so the connection is
// cached at module scope and reused across warm invocations instead of reconnecting every call.
// A cold start pays the connect cost once; every warm invocation after that reuses the same
// client.

interface DbSecret {
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

async function loadDbSecret(secretArn: string): Promise<DbSecret> {
  const secretsClient = new SecretsManagerClient({});
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }
  return JSON.parse(response.SecretString) as DbSecret;
}

async function connect(): Promise<Client> {
  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DB_SECRET_ARN environment variable is not set');
  }

  const creds = await loadDbSecret(secretArn);
  const client = new Client({
    host: creds.host,
    port: creds.port,
    database: creds.dbname,
    user: creds.username,
    password: creds.password,
    // Encrypts the connection. Not verifying the RDS CA chain here is an accepted trade-off,
    // same as infra/lib/lambda/migrate/handler.ts: this connection never leaves the isolated VPC
    // subnet the DB's security group is scoped to.
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

/**
 * Returns a connected pg Client, reusing the cached one across warm invocations. Does not
 * proactively health-check the cached connection (that would add latency to every request) — if
 * a query against it fails because the connection has gone bad (RDS failover, idle timeout),
 * call resetDb() from the catch block so the *next* invocation reconnects from scratch.
 */
export async function getDb(): Promise<Client> {
  if (client) {
    return client;
  }
  if (!connecting) {
    connecting = connect()
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

/** Drops the cached client so the next getDb() call reconnects from scratch. Does not call
 *  client.end() — if the underlying socket is already dead, end() can hang or throw; simplest is
 *  to just drop the reference. */
export function resetDb(): void {
  client = null;
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createListMyBookingsHandler, listBookingsForOwner } from './list-my-bookings';

// Stage 2E: GET /bookings/me (SANDBOX) and GET /bookings/production/me (PRODUCTION) each return
// only the caller's own bookings in their one hard-coded environment.

interface StoredBooking {
  id: string;
  booking_number: number;
  cognito_sub: string;
  booking_environment: string | null;
}

const ME = 'sub-me';
const OTHER = 'sub-other';

const STORE: StoredBooking[] = [
  { id: 'b-sandbox-1031', booking_number: 1031, cognito_sub: ME, booking_environment: 'SANDBOX' },
  { id: 'b-sandbox-1032', booking_number: 1032, cognito_sub: ME, booking_environment: 'SANDBOX' },
  { id: 'b-prod-1033', booking_number: 1033, cognito_sub: ME, booking_environment: 'PRODUCTION' },
  { id: 'b-null', booking_number: 1000, cognito_sub: ME, booking_environment: null },
  { id: 'b-other-prod', booking_number: 1040, cognito_sub: OTHER, booking_environment: 'PRODUCTION' },
  { id: 'b-other-sandbox', booking_number: 1041, cognito_sub: OTHER, booking_environment: 'SANDBOX' },
];

/** Evaluates the handler's query against STORE: asserts the SQL shape, then applies its two
 *  bound parameters the way Postgres would (`=` never matches NULL). */
function fakeDb() {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query<T>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      assert.match(text, /WHERE b\.cognito_sub = \$1\s+AND b\.booking_environment = \$2/);
      const [sub, env] = params;
      const rows = STORE.filter((b) => b.cognito_sub === sub && b.booking_environment !== null && b.booking_environment === env).map((b) => ({
        id: b.id,
        booking_number: b.booking_number,
        product_code: 'solo-pro-static',
        price_inr: '399.00',
        scheduled_start_at: new Date('2026-09-26T10:00:00Z'),
        status: 'confirmed',
        notes: null,
        created_at: new Date('2026-09-24T10:00:00Z'),
      }));
      return { rows: rows as unknown as T[] };
    },
  };
}

function event(sub: unknown, extra: Partial<APIGatewayProxyEventV2WithJWTAuthorizer> = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: { authorizer: { jwt: { claims: sub === undefined ? {} : { sub }, scopes: [] } } },
    ...extra,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

async function list(environment: 'SANDBOX' | 'PRODUCTION', ev: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const db = fakeDb();
  const handler = createListMyBookingsHandler(environment, { getDb: async () => db, resetDb: () => {} });
  const res = await handler(ev);
  const body = JSON.parse(String(res.body));
  return { res, body, db };
}

test('GET /bookings/production/me returns only the caller\'s PRODUCTION bookings (sandbox #1031/#1032 excluded)', async () => {
  const { res, body, db } = await list('PRODUCTION', event(ME));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.bookings.map((b: { bookingNumber: number }) => b.bookingNumber), [1033]);
  assert.deepEqual(db.calls[0].params, [ME, 'PRODUCTION']);
});

test('GET /bookings/me returns only the caller\'s SANDBOX bookings (production #1033 excluded)', async () => {
  const { res, body, db } = await list('SANDBOX', event(ME));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.bookings.map((b: { bookingNumber: number }) => b.bookingNumber), [1031, 1032]);
  assert.deepEqual(db.calls[0].params, [ME, 'SANDBOX']);
});

test('ownership is preserved in both environments: another customer\'s bookings never appear', async () => {
  for (const environment of ['SANDBOX', 'PRODUCTION'] as const) {
    const { body } = await list(environment, event(ME));
    assert.ok(!JSON.stringify(body).includes('b-other'), environment);
  }
});

test('a NULL/unknown stored environment is returned by neither route', async () => {
  for (const environment of ['SANDBOX', 'PRODUCTION'] as const) {
    const { body } = await list(environment, event(ME));
    assert.ok(!body.bookings.some((b: { id: string }) => b.id === 'b-null'), environment);
  }
});

test('nothing client-controlled can change the environment: query string, headers, body and Origin are ignored', async () => {
  const hostile = {
    queryStringParameters: { environment: 'SANDBOX', booking_environment: 'SANDBOX' },
    rawQueryString: 'environment=SANDBOX',
    headers: { origin: 'https://staging.playxcafe.com', host: 'staging.playxcafe.com', 'x-environment': 'SANDBOX' },
    body: JSON.stringify({ environment: 'SANDBOX', sub: OTHER }),
  } as Partial<APIGatewayProxyEventV2WithJWTAuthorizer>;
  const prod = await list('PRODUCTION', event(ME, hostile));
  assert.deepEqual(prod.db.calls[0].params, [ME, 'PRODUCTION']);
  assert.deepEqual(prod.body.bookings.map((b: { bookingNumber: number }) => b.bookingNumber), [1033]);

  const sandbox = await list('SANDBOX', event(ME, { ...hostile, queryStringParameters: { environment: 'PRODUCTION' } }));
  assert.deepEqual(sandbox.db.calls[0].params, [ME, 'SANDBOX']);
});

test('missing subject -> 401 before any DB work', async () => {
  let getDb = 0;
  const handler = createListMyBookingsHandler('PRODUCTION', { getDb: async () => { getDb += 1; return fakeDb(); }, resetDb: () => {} });
  const res = await handler(event(undefined));
  assert.equal(res.statusCode, 401);
  assert.equal(getDb, 0);
});

test('an unknown environment fails at build time and before any SQL', async () => {
  assert.throws(() => createListMyBookingsHandler('STAGING' as never));
  const db = fakeDb();
  await assert.rejects(() => listBookingsForOwner(db, ME, 'staging' as never));
  assert.equal(db.calls.length, 0);
});

test('entry files hard-code their environment', () => {
  const dir = path.dirname(__filename);
  assert.match(readFileSync(path.join(dir, 'list-my-bookings.ts'), 'utf8'), /^export const handler = createListMyBookingsHandler\('SANDBOX'\);$/m);
  assert.match(
    readFileSync(path.join(dir, 'list-my-bookings-production.ts'), 'utf8'),
    /^export const handler = createListMyBookingsHandler\('PRODUCTION'\);$/m,
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { AdminAuthorizationError, authorizeAdmin, parseCognitoGroups, requireAdmin } from './admin-auth';

// Phase 3B: requireAdmin() is the sole authorization gate on every /admin/* route — see
// admin-auth.ts's header. These tests are the explicit "unauthenticated / authenticated non-admin
// / admin group member" matrix item 13/14 of the brief asks for, plus coverage of the different
// claim shapes API Gateway can actually hand back for cognito:groups.

function makeEvent(claims: Record<string, unknown> | undefined): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: '2.0',
    routeKey: 'GET /admin/dashboard',
    rawPath: '/admin/dashboard',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      domainPrefix: 'test',
      http: { method: 'GET', path: '/admin/dashboard', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test-request-id',
      routeKey: 'GET /admin/dashboard',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
      authorizer: claims === undefined ? (undefined as never) : { jwt: { claims, scopes: [] } },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

test('parseCognitoGroups: a real string[] (the JWT claim\'s native shape)', () => {
  assert.deepEqual(parseCognitoGroups(['admin', 'staff']), ['admin', 'staff']);
});

test('parseCognitoGroups: a single bare string', () => {
  assert.deepEqual(parseCognitoGroups('admin'), ['admin']);
});

test('parseCognitoGroups: a comma-joined string', () => {
  assert.deepEqual(parseCognitoGroups('admin,staff'), ['admin', 'staff']);
});

test('parseCognitoGroups: a bracketed string, as API Gateway\'s HTTP API JWT authorizer emits it', () => {
  assert.deepEqual(parseCognitoGroups('[admin, staff]'), ['admin', 'staff']);
  assert.deepEqual(parseCognitoGroups('[admin]'), ['admin']);
});

test('parseCognitoGroups: missing/malformed claim shapes safely yield []', () => {
  assert.deepEqual(parseCognitoGroups(undefined), []);
  assert.deepEqual(parseCognitoGroups(null), []);
  assert.deepEqual(parseCognitoGroups(42), []);
  assert.deepEqual(parseCognitoGroups(''), []);
  assert.deepEqual(parseCognitoGroups('  '), []);
  assert.deepEqual(parseCognitoGroups('[]'), []);
});

test('admin group member: array claim containing "admin" is allowed', () => {
  const event = makeEvent({ sub: 'admin-sub-1', 'cognito:groups': ['admin'] });
  assert.equal(requireAdmin(event), 'admin-sub-1');
});

test('admin group member: "admin" alongside other groups is allowed', () => {
  const event = makeEvent({ sub: 'admin-sub-2', 'cognito:groups': ['staff', 'admin'] });
  assert.equal(requireAdmin(event), 'admin-sub-2');
});

test('admin group member: bracketed-string claim form is allowed', () => {
  const event = makeEvent({ sub: 'admin-sub-3', 'cognito:groups': '[admin]' });
  assert.equal(requireAdmin(event), 'admin-sub-3');
});

test('authenticated non-admin customer: a valid sub with no admin group is rejected with 403', () => {
  const event = makeEvent({ sub: 'customer-sub', 'cognito:groups': ['customer'] });
  assert.throws(() => requireAdmin(event), (err: unknown) => {
    assert.ok(err instanceof AdminAuthorizationError);
    assert.equal(err.statusCode, 403);
    return true;
  });
});

test('authenticated non-admin customer: no cognito:groups claim at all is rejected with 403', () => {
  const event = makeEvent({ sub: 'customer-sub-2' });
  assert.throws(() => requireAdmin(event), (err: unknown) => {
    assert.ok(err instanceof AdminAuthorizationError);
    assert.equal(err.statusCode, 403);
    return true;
  });
});

test('malformed admin claim: a non-array, non-string cognito:groups is rejected with 403, not thrown as a crash', () => {
  const event = makeEvent({ sub: 'customer-sub-3', 'cognito:groups': 12345 });
  assert.throws(() => requireAdmin(event), (err: unknown) => {
    assert.ok(err instanceof AdminAuthorizationError);
    assert.equal(err.statusCode, 403);
    return true;
  });
});

test('unauthenticated/missing authorizer context: rejected with 401, never treated as admin', () => {
  const event = makeEvent(undefined);
  assert.throws(() => requireAdmin(event), (err: unknown) => {
    assert.ok(err instanceof AdminAuthorizationError);
    assert.equal(err.statusCode, 401);
    return true;
  });
});

test('missing subject claim: rejected with 401', () => {
  const event = makeEvent({ 'cognito:groups': ['admin'] });
  assert.throws(() => requireAdmin(event), (err: unknown) => {
    assert.ok(err instanceof AdminAuthorizationError);
    assert.equal(err.statusCode, 401);
    return true;
  });
});

test('no request body/query parameter can grant admin: an "isAdmin" claim is never consulted', () => {
  // requireAdmin only ever reads event.requestContext.authorizer.jwt.claims — there is no code
  // path here that looks at event.body or event.queryStringParameters at all, so a forged
  // isAdmin=true in either has zero effect. This test documents that by constructing an event
  // whose only admin-shaped signal is in the wrong place and confirming it's still rejected.
  const event = makeEvent({ sub: 'attacker-sub', 'cognito:groups': ['customer'] });
  (event as unknown as { queryStringParameters: Record<string, string> }).queryStringParameters = { isAdmin: 'true' };
  (event as unknown as { body: string }).body = JSON.stringify({ isAdmin: true, role: 'admin' });
  assert.throws(() => requireAdmin(event), AdminAuthorizationError);
});

test('authorizeAdmin: returns a ready-to-return 403 response for a non-admin, without throwing', () => {
  const event = makeEvent({ sub: 'customer-sub', 'cognito:groups': ['customer'] });
  const result = authorizeAdmin(event);
  assert.equal(result.authorized, false);
  if (!result.authorized) {
    assert.equal(result.response.statusCode, 403);
    assert.match(String(result.response.body), /forbidden/);
  }
});

test('authorizeAdmin: returns the sub for an admin', () => {
  const event = makeEvent({ sub: 'admin-sub', 'cognito:groups': ['admin'] });
  const result = authorizeAdmin(event);
  assert.equal(result.authorized, true);
  if (result.authorized) {
    assert.equal(result.sub, 'admin-sub');
  }
});

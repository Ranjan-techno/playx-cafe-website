import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from './availability';

// GET /availability query-string validation. Same scope as create-booking.test.ts's parseBody
// tests: the only AWS/DB-free logic in this handler.

test('valid query: productCode + date parses through unchanged', () => {
  assert.deepEqual(parseQuery({ productCode: 'solo-pro-static', date: '2026-09-10' }), {
    productCode: 'solo-pro-static',
    date: '2026-09-10',
  });
});

test('missing productCode is rejected', () => {
  assert.equal(parseQuery({ date: '2026-09-10' }), null);
});

test('missing date is rejected', () => {
  assert.equal(parseQuery({ productCode: 'solo-pro-static' }), null);
});

test('malformed date (not YYYY-MM-DD) is rejected', () => {
  assert.equal(parseQuery({ productCode: 'solo-pro-static', date: '10-09-2026' }), null);
  assert.equal(parseQuery({ productCode: 'solo-pro-static', date: '2026/09/10' }), null);
});

test('productCode with characters outside [a-z0-9-] is rejected', () => {
  assert.equal(parseQuery({ productCode: 'solo pro static', date: '2026-09-10' }), null);
  assert.equal(parseQuery({ productCode: 'solo-pro-static;DROP TABLE', date: '2026-09-10' }), null);
});

test('no query string at all (undefined/null) is rejected, not thrown', () => {
  assert.equal(parseQuery(undefined), null);
  assert.equal(parseQuery(null), null);
});

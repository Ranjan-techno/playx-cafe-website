import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallbackResponse } from '@phonepe-pg/pg-sdk-node';
import { authenticateCallback, extractCallbackMerchantOrderId, headerValue, readRawBody } from './phonepe-callback';
import {
  assertProductionAccessAllowed,
  assertProductionTesterAllowed,
  isProductionAccessAllowed,
  isProductionTester,
  parseProductionTesters,
  ProductionTesterNotAllowedError,
  resolveProductionAccessMode,
} from './production-access';

const cb = (payload: unknown) => ({ type: 'CHECKOUT_ORDER_COMPLETED', payload }) as unknown as CallbackResponse;

test('readRawBody: plain bodies are returned byte-for-byte; base64 bodies are decoded as UTF-8; absent/empty -> null', () => {
  const raw = ' {"a" : "café"}\n';
  assert.equal(readRawBody({ body: raw, isBase64Encoded: false }), raw);
  assert.equal(readRawBody({ body: raw }), raw);
  assert.equal(readRawBody({ body: Buffer.from(raw).toString('base64'), isBase64Encoded: true }), raw);
  for (const event of [{}, { body: undefined }, { body: null }, { body: '' }, { body: '', isBase64Encoded: true }]) {
    assert.equal(readRawBody(event), null, JSON.stringify(event));
  }
});

test('headerValue: case-insensitive name, value untouched, absent -> undefined', () => {
  assert.equal(headerValue({ Authorization: ' abc ' }, 'authorization'), ' abc ');
  assert.equal(headerValue({ AUTHORIZATION: 'x' }, 'Authorization'), 'x');
  assert.equal(headerValue({ other: 'x' }, 'authorization'), undefined);
  assert.equal(headerValue(undefined, 'authorization'), undefined);
  assert.equal(headerValue({ authorization: undefined }, 'authorization'), undefined);
});

test('authenticateCallback: SDK rejection -> unauthenticated; SyntaxError -> malformed; non-object -> malformed; object -> ok', () => {
  const invalid = () => { throw Object.assign(new Error('Invalid Callback'), { httpStatusCode: 417 }); };
  assert.deepEqual(authenticateCallback(invalid, 'a', '{}'), { ok: false, reason: 'unauthenticated' });
  const parse = (_a: string, body: string) => JSON.parse(body) as CallbackResponse;
  assert.deepEqual(authenticateCallback(parse, 'a', '{oops'), { ok: false, reason: 'malformed' });
  for (const body of ['null', '[]', '1', '"s"']) {
    assert.deepEqual(authenticateCallback(parse, 'a', body), { ok: false, reason: 'malformed' }, body);
  }
  const ok = authenticateCallback(parse, 'a', '{"payload":{}}');
  assert.equal(ok.ok, true);
});

test('extractCallbackMerchantOrderId: payload.merchantOrderId only — never orderId / originalMerchantOrderId; refund callbacks ignored', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
  assert.equal(extractCallbackMerchantOrderId(cb({ merchantOrderId: id, orderId: 'OMO123' })), id);
  assert.equal(extractCallbackMerchantOrderId(cb({ merchantOrderId: 'A_b-9' })), 'A_b-9');
  assert.equal(extractCallbackMerchantOrderId(cb({ orderId: 'OMO123' })), null, 'PhonePe internal id is never a fallback');
  assert.equal(extractCallbackMerchantOrderId(cb({ originalMerchantOrderId: id, merchantRefundId: 'R1', refundId: 'OMR1' })), null);
  assert.equal(extractCallbackMerchantOrderId(cb({ merchantOrderId: id, merchantRefundId: 'R1' })), null, 'refund-shaped');
  assert.equal(extractCallbackMerchantOrderId(cb({ merchantOrderId: id, refundId: 'OMR1' })), null, 'refund-shaped');
  for (const bad of ['', ' ', 'a b', 'x'.repeat(64), 'id;DROP', 'café', 42, null, {}, [id]]) {
    assert.equal(extractCallbackMerchantOrderId(cb({ merchantOrderId: bad })), null, JSON.stringify(bad));
  }
  assert.equal(extractCallbackMerchantOrderId(cb('x'.repeat(63))), null);
  assert.equal(extractCallbackMerchantOrderId(cb(null)), null);
  assert.equal(extractCallbackMerchantOrderId(cb([{ merchantOrderId: id }])), null);
  assert.equal(extractCallbackMerchantOrderId({} as CallbackResponse), null);
});

test('production testers: comma list of subs, trimmed, exact match; empty list denies everyone; emails are not identities', () => {
  assert.deepEqual([...parseProductionTesters(' sub-a , ,sub-b,')], ['sub-a', 'sub-b']);
  assert.equal(isProductionTester('sub-a', 'sub-a,sub-b'), true);
  assert.equal(isProductionTester('sub-b', ' sub-a , sub-b '), true);
  assert.equal(isProductionTester('SUB-A', 'sub-a'), false, 'exact match');
  assert.equal(isProductionTester('sub-a ', 'sub-a'), false);
  assert.equal(isProductionTester('sub-c', 'sub-a,sub-b'), false);
  assert.equal(isProductionTester('', ','), false);
  for (const empty of [undefined, '', '   ', ' , , ']) {
    assert.equal(isProductionTester('sub-a', empty), false, JSON.stringify(empty));
    assert.throws(() => assertProductionTesterAllowed('sub-a', empty), ProductionTesterNotAllowedError);
  }
  assert.doesNotThrow(() => assertProductionTesterAllowed('sub-a', 'sub-a'));
});

test('production access mode: only the exact string PUBLIC selects PUBLIC; everything else is TESTER', () => {
  assert.equal(resolveProductionAccessMode('PUBLIC'), 'PUBLIC');
  for (const raw of [undefined, '', 'TESTER', 'public', ' PUBLIC', 'PUBLIC ', 'OPEN', 'ALL']) {
    assert.equal(resolveProductionAccessMode(raw), 'TESTER', JSON.stringify(raw));
  }
});

test('production access mode: TESTER requires the allowlist (empty fails closed); PUBLIC requires only a verified sub', () => {
  assert.equal(isProductionAccessAllowed('sub-a', { PHONEPE_PRODUCTION_TESTERS: 'sub-a' }), true);
  assert.equal(isProductionAccessAllowed('sub-b', { PHONEPE_PRODUCTION_TESTERS: 'sub-a' }), false);
  assert.equal(isProductionAccessAllowed('sub-a', { PHONEPE_PRODUCTION_ACCESS_MODE: 'TESTER', PHONEPE_PRODUCTION_TESTERS: '' }), false);
  assert.equal(isProductionAccessAllowed('sub-a', {}), false, 'no mode + no list = nobody');
  assert.equal(isProductionAccessAllowed('sub-a', { PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC' }), true);
  assert.equal(isProductionAccessAllowed('', { PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC' }), false, 'PUBLIC still needs a subject');
  assert.throws(() => assertProductionAccessAllowed('sub-a', { PHONEPE_PRODUCTION_TESTERS: ' , ' }), ProductionTesterNotAllowedError);
  assert.doesNotThrow(() => assertProductionAccessAllowed('sub-z', { PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC' }));
});

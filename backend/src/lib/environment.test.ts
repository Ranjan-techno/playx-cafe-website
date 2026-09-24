import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  effectiveEnvironmentSql,
  effectiveStoredEnvironment,
  environmentMatchSql,
  storedEnvironmentMatches,
} from './environment';

// Migration 007 made booking_environment/payment_environment NOT NULL; matching is strict and
// NULL/unknown matches no environment.

test('effectiveStoredEnvironment: only the two known values survive; NULL/undefined/unknown -> null', () => {
  assert.equal(effectiveStoredEnvironment('SANDBOX'), 'SANDBOX');
  assert.equal(effectiveStoredEnvironment('PRODUCTION'), 'PRODUCTION');
  assert.equal(effectiveStoredEnvironment(null), null);
  assert.equal(effectiveStoredEnvironment(undefined), null);
  for (const v of ['', 'sandbox', 'production', 'LIVE', ' SANDBOX', 'NULL']) {
    assert.equal(effectiveStoredEnvironment(v), null, JSON.stringify(v));
  }
});

test('storedEnvironmentMatches: SANDBOX only matches SANDBOX, PRODUCTION only PRODUCTION', () => {
  assert.equal(storedEnvironmentMatches('SANDBOX', 'SANDBOX'), true);
  assert.equal(storedEnvironmentMatches('SANDBOX', 'PRODUCTION'), false);
  assert.equal(storedEnvironmentMatches('PRODUCTION', 'PRODUCTION'), true);
  assert.equal(storedEnvironmentMatches('PRODUCTION', 'SANDBOX'), false);
});

test('storedEnvironmentMatches: NULL/undefined/unknown never matches SANDBOX or PRODUCTION', () => {
  for (const v of [null, undefined, '', 'sandbox', 'LIVE']) {
    assert.equal(storedEnvironmentMatches(v, 'SANDBOX'), false, `${String(v)} vs SANDBOX`);
    assert.equal(storedEnvironmentMatches(v, 'PRODUCTION'), false, `${String(v)} vs PRODUCTION`);
  }
});

test('environmentMatchSql: both environments generate exactly `column = $n`, no IS NULL branch', () => {
  assert.equal(environmentMatchSql('payment_environment', '$1', 'SANDBOX'), 'payment_environment = $1');
  assert.equal(environmentMatchSql('payment_environment', '$1', 'PRODUCTION'), 'payment_environment = $1');
  assert.equal(environmentMatchSql('b.booking_environment', '$3', 'SANDBOX'), 'b.booking_environment = $3');
  for (const env of ['SANDBOX', 'PRODUCTION'] as const) {
    const sql = environmentMatchSql('payment_environment', '$1', env);
    assert.doesNotMatch(sql, /IS NULL/i);
    assert.doesNotMatch(sql, /\bOR\b/i);
    assert.doesNotMatch(sql, /'(SANDBOX|PRODUCTION)'/, 'environment is bound, never interpolated');
  }
});

test('environmentMatchSql: an unknown environment throws', () => {
  for (const env of [undefined, null, '', 'sandbox', 'LIVE']) {
    assert.throws(() => environmentMatchSql('payment_environment', '$1', env as never), /environment must be SANDBOX or PRODUCTION/);
  }
});

test('effectiveEnvironmentSql: the typed column itself, no COALESCE fallback', () => {
  assert.equal(effectiveEnvironmentSql('payment_environment'), 'payment_environment');
  assert.equal(effectiveEnvironmentSql('b.booking_environment'), 'b.booking_environment');
  assert.doesNotMatch(effectiveEnvironmentSql('payment_environment'), /COALESCE|SANDBOX/i);
});

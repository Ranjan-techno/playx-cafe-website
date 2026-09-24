import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inrToPaise, paiseToInr } from './money';

test('INR -> paise: exact for NUMERIC strings, whole rupees, one-decimal and numbers', () => {
  assert.equal(inrToPaise('999.00'), 99900);
  assert.equal(inrToPaise('999'), 99900);
  assert.equal(inrToPaise('999.5'), 99950);
  assert.equal(inrToPaise('0.05'), 5);
  assert.equal(inrToPaise(500), 50000);
  assert.equal(inrToPaise(12.5), 1250);
});

test('INR -> paise: the classic float traps are exact (1.15, 19.99, 0.29 all survive)', () => {
  assert.equal(inrToPaise('1.15'), 115); // 1.15 * 100 === 114.99999999999999 in floating point
  assert.equal(inrToPaise('19.99'), 1999);
  assert.equal(inrToPaise('0.29'), 29);
  assert.equal(inrToPaise(1.15), 115);
});

test('INR -> paise: refuses ambiguous input instead of rounding money', () => {
  for (const bad of ['1.005', '-1.00', '1e3', '', 'abc', '1,000.00', '1.', '.5', ' ']) {
    assert.throws(() => inrToPaise(bad), /Invalid INR amount/, `expected "${bad}" to be rejected`);
  }
  assert.throws(() => inrToPaise(0.1 + 0.2), /Invalid INR amount/, 'float representation noise must not be silently rounded');
  assert.throws(() => inrToPaise(Number.NaN));
  assert.throws(() => inrToPaise(-5));
});

test('paise -> INR: canonical two-decimal string, integers only', () => {
  assert.equal(paiseToInr(99900), '999.00');
  assert.equal(paiseToInr(5), '0.05');
  assert.equal(paiseToInr(0), '0.00');
  assert.equal(paiseToInr(115), '1.15');
  assert.throws(() => paiseToInr(1.5));
  assert.throws(() => paiseToInr(-1));
});

test('round trip: paise -> INR -> paise is the identity across a sweep', () => {
  for (let paise = 0; paise <= 100_000; paise += 7) {
    assert.equal(inrToPaise(paiseToInr(paise)), paise);
  }
});

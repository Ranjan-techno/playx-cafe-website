import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CHECKOUT_HOLD_MINUTES, getCheckoutHoldMinutes } from './payment-settings';

test('checkout hold minutes: default, configurable, and bounds-checked', () => {
  assert.equal(getCheckoutHoldMinutes({}), DEFAULT_CHECKOUT_HOLD_MINUTES);
  assert.equal(getCheckoutHoldMinutes({ PAYMENT_CHECKOUT_HOLD_MINUTES: '30' }), 30);
  for (const bad of ['0', '4', '61', '1.5', 'abc']) {
    assert.throws(() => getCheckoutHoldMinutes({ PAYMENT_CHECKOUT_HOLD_MINUTES: bad }), /PAYMENT_CHECKOUT_HOLD_MINUTES/);
  }
});

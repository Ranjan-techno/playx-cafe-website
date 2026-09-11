import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_STATUSES,
  confirmsAllocationOnTransition,
  isAllowedTransition,
  isValidBookingStatus,
  releasesAllocationOnTransition,
} from './booking-status';

test('isValidBookingStatus: accepts every real booking_status enum value', () => {
  for (const status of BOOKING_STATUSES) {
    assert.equal(isValidBookingStatus(status), true);
  }
});

test('isValidBookingStatus: rejects a not-yet-real status like "checked_in"', () => {
  assert.equal(isValidBookingStatus('checked_in'), false);
});

test('isValidBookingStatus: rejects non-strings and free text', () => {
  assert.equal(isValidBookingStatus(undefined), false);
  assert.equal(isValidBookingStatus(null), false);
  assert.equal(isValidBookingStatus(123), false);
  assert.equal(isValidBookingStatus('paid'), false);
  assert.equal(isValidBookingStatus('PENDING'), false);
});

test('valid transitions: pending -> confirmed and pending -> cancelled are allowed', () => {
  assert.equal(isAllowedTransition('pending', 'confirmed'), true);
  assert.equal(isAllowedTransition('pending', 'cancelled'), true);
});

test('valid transitions: confirmed -> cancelled/completed/no_show are allowed', () => {
  assert.equal(isAllowedTransition('confirmed', 'cancelled'), true);
  assert.equal(isAllowedTransition('confirmed', 'completed'), true);
  assert.equal(isAllowedTransition('confirmed', 'no_show'), true);
});

test('invalid transitions: terminal statuses accept nothing', () => {
  for (const to of BOOKING_STATUSES) {
    assert.equal(isAllowedTransition('cancelled', to), false);
    assert.equal(isAllowedTransition('completed', to), false);
    assert.equal(isAllowedTransition('no_show', to), false);
  }
});

test('invalid transitions: pending cannot jump straight to completed/no_show', () => {
  assert.equal(isAllowedTransition('pending', 'completed'), false);
  assert.equal(isAllowedTransition('pending', 'no_show'), false);
});

test('invalid transitions: a status can never transition to itself through this whitelist', () => {
  assert.equal(isAllowedTransition('pending', 'pending'), false);
  assert.equal(isAllowedTransition('confirmed', 'confirmed'), false);
});

test('releasesAllocationOnTransition: only "cancelled" releases the simulator allocation', () => {
  assert.equal(releasesAllocationOnTransition('cancelled'), true);
  assert.equal(releasesAllocationOnTransition('confirmed'), false);
  assert.equal(releasesAllocationOnTransition('completed'), false);
  assert.equal(releasesAllocationOnTransition('no_show'), false);
  assert.equal(releasesAllocationOnTransition('pending'), false);
});

test('confirmsAllocationOnTransition: only "confirmed" confirms the HOLD simulator allocation', () => {
  assert.equal(confirmsAllocationOnTransition('confirmed'), true);
  assert.equal(confirmsAllocationOnTransition('cancelled'), false);
  assert.equal(confirmsAllocationOnTransition('completed'), false);
  assert.equal(confirmsAllocationOnTransition('no_show'), false);
  assert.equal(confirmsAllocationOnTransition('pending'), false);
});

test('confirmsAllocationOnTransition and releasesAllocationOnTransition are mutually exclusive for every status', () => {
  for (const status of BOOKING_STATUSES) {
    assert.ok(
      !(confirmsAllocationOnTransition(status) && releasesAllocationOnTransition(status)),
      `${status} must not both confirm and release an allocation`,
    );
  }
});

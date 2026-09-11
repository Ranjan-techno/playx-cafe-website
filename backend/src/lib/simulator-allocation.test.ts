import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE_TIME, effectiveOpenTime, parseTimeToMinutes } from './opening-hours';
import {
  computeAvailableSlots,
  legacyReservedCounts,
  occupiedSimulatorIds,
  pickSimulators,
  requirementForProduct,
  type BlockingAllocation,
  type LegacyBookingWindow,
  type SimulatorRow,
} from './simulator-allocation';

// Phase 2 PHYSICAL INVENTORY, exactly as seeded by database/migrations/002_simulator_inventory.sql.
const S1: SimulatorRow = { id: 's1', code: 'S1', simulator_type: 'static' };
const S2: SimulatorRow = { id: 's2', code: 'S2', simulator_type: 'static' };
const M1: SimulatorRow = { id: 'm1', code: 'M1', simulator_type: 'motion' };
const M2: SimulatorRow = { id: 'm2', code: 'M2', simulator_type: 'motion' };
const INVENTORY: SimulatorRow[] = [S1, S2, M1, M2];

test('requirementForProduct: Solo Static requires 1 static', () => {
  assert.deepEqual(requirementForProduct({ simulatorType: 'static', racers: 1 }), { static: 1, motion: 0 });
});

test('requirementForProduct: Solo Motion requires 1 motion', () => {
  assert.deepEqual(requirementForProduct({ simulatorType: 'motion', racers: 1 }), { static: 0, motion: 1 });
});

test('requirementForProduct: Duo Static requires 2 static', () => {
  assert.deepEqual(requirementForProduct({ simulatorType: 'static', racers: 2 }), { static: 2, motion: 0 });
});

test('requirementForProduct: Duo Motion requires 2 motion', () => {
  assert.deepEqual(requirementForProduct({ simulatorType: 'motion', racers: 2 }), { static: 0, motion: 2 });
});

test('requirementForProduct: Grand Race requires all 4 (2 static + 2 motion)', () => {
  assert.deepEqual(requirementForProduct({ simulatorType: null, racers: 4 }), { static: 2, motion: 2 });
});

test('requirementForProduct: an unrecognized null-simulatorType/non-4-racer shape throws rather than guessing', () => {
  assert.throws(() => requirementForProduct({ simulatorType: null, racers: 3 }));
});

test('pickSimulators: static allocation picks the free static rig when the other is occupied (S1 occupied, S2 free)', () => {
  const picked = pickSimulators(INVENTORY, { static: 1, motion: 0 }, new Set(['s1']));
  assert.deepEqual(picked?.map((s) => s.code), ['S2']);
});

test('pickSimulators: motion allocation picks a free motion rig', () => {
  const picked = pickSimulators(INVENTORY, { static: 0, motion: 1 }, new Set());
  assert.deepEqual(picked?.map((s) => s.code), ['M1']);
});

test('pickSimulators: duo allocation picks both static rigs when both are free', () => {
  const picked = pickSimulators(INVENTORY, { static: 2, motion: 0 }, new Set());
  assert.deepEqual(picked?.map((s) => s.code), ['S1', 'S2']);
});

test('pickSimulators: duo allocation rejects when only one static rig is free', () => {
  const picked = pickSimulators(INVENTORY, { static: 2, motion: 0 }, new Set(['s1']));
  assert.equal(picked, null);
});

test('pickSimulators: Grand Race picks all 4 rigs when every rig is free', () => {
  const picked = pickSimulators(INVENTORY, { static: 2, motion: 2 }, new Set());
  assert.deepEqual(
    picked?.map((s) => s.code).sort(),
    ['M1', 'M2', 'S1', 'S2'],
  );
});

test('pickSimulators: Grand Race rejects when any one rig is occupied', () => {
  assert.equal(pickSimulators(INVENTORY, { static: 2, motion: 2 }, new Set(['m2'])), null);
});

test('pickSimulators: a second Solo Static request rejects once both static rigs are taken', () => {
  assert.equal(pickSimulators(INVENTORY, { static: 1, motion: 0 }, new Set(['s1', 's2'])), null);
});

test('pickSimulators: an inactive/removed rig (absent from inventory) is never picked', () => {
  const picked = pickSimulators([S1], { static: 1, motion: 0 }, new Set(['s1']));
  assert.equal(picked, null);
});

// Legacy-booking backward compatibility (see allocate-simulators.ts's header): a bookings row
// with no booking_allocations rows of its own still occupies capacity by type/count, never a
// specific simulator id.

test('legacyReservedCounts: a legacy Solo Static booking reserves 1 static, 0 motion', () => {
  const start = new Date('2026-09-10T10:00:00Z');
  const end = new Date('2026-09-10T11:00:00Z');
  const legacy: LegacyBookingWindow[] = [
    { requirement: { static: 1, motion: 0 }, scheduledStartAt: start, scheduledEndAt: end },
  ];
  assert.deepEqual(legacyReservedCounts(legacy, start, end), { static: 1, motion: 0 });
});

test('legacyReservedCounts: sums demand across multiple overlapping legacy bookings', () => {
  const start = new Date('2026-09-10T10:00:00Z');
  const end = new Date('2026-09-10T11:00:00Z');
  const legacy: LegacyBookingWindow[] = [
    { requirement: { static: 1, motion: 0 }, scheduledStartAt: start, scheduledEndAt: end },
    // Legacy Grand Race: 2 static + 2 motion.
    { requirement: { static: 2, motion: 2 }, scheduledStartAt: start, scheduledEndAt: end },
  ];
  assert.deepEqual(legacyReservedCounts(legacy, start, end), { static: 3, motion: 2 });
});

test('legacyReservedCounts: a legacy booking outside [start, end) is not counted', () => {
  const start = new Date('2026-09-10T10:00:00Z');
  const end = new Date('2026-09-10T11:00:00Z');
  const legacy: LegacyBookingWindow[] = [
    {
      requirement: { static: 1, motion: 0 },
      scheduledStartAt: new Date('2026-09-10T08:00:00Z'),
      scheduledEndAt: new Date('2026-09-10T09:00:00Z'),
    },
  ];
  assert.deepEqual(legacyReservedCounts(legacy, start, end), { static: 0, motion: 0 });
});

test('pickSimulators: a legacy booking\'s reserved capacity blocks a new booking with no specific id occupied', () => {
  // Both static rigs are free per booking_allocations (occupied is empty), but a legacy booking
  // already claims 1 static unit of capacity for this window — a second Solo Static should still
  // succeed (2 rigs - 1 legacy = 1 free), a Duo Static should not (2 rigs - 1 legacy = 1 free < 2).
  const solo = pickSimulators(INVENTORY, { static: 1, motion: 0 }, new Set(), { static: 1, motion: 0 });
  assert.deepEqual(solo?.map((s) => s.code), ['S1']);

  const duo = pickSimulators(INVENTORY, { static: 2, motion: 0 }, new Set(), { static: 1, motion: 0 });
  assert.equal(duo, null, 'legacy demand plus the new Duo Static request exceeds the 2 static rigs available');
});

test('occupiedSimulatorIds: only allocations whose window overlaps [start, end) count', () => {
  const start = new Date('2026-09-10T10:00:00Z');
  const end = new Date('2026-09-10T11:00:00Z');
  const allocations: BlockingAllocation[] = [
    // Overlaps.
    { simulatorId: 's1', scheduledStartAt: new Date('2026-09-10T10:30:00Z'), scheduledEndAt: new Date('2026-09-10T11:30:00Z') },
    // Ends exactly when the window starts — does not overlap (half-open interval).
    { simulatorId: 's2', scheduledStartAt: new Date('2026-09-10T09:00:00Z'), scheduledEndAt: new Date('2026-09-10T10:00:00Z') },
    // Starts exactly when the window ends — does not overlap.
    { simulatorId: 'm1', scheduledStartAt: new Date('2026-09-10T11:00:00Z'), scheduledEndAt: new Date('2026-09-10T12:00:00Z') },
  ];
  assert.deepEqual([...occupiedSimulatorIds(allocations, start, end)], ['s1']);
});

test('computeAvailableSlots: an all-day-free Solo Static day offers every 15-minute slot that finishes by closing', () => {
  const toUtc = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(Date.UTC(year, month - 1, day, hours, minutes));

  const slots = computeAvailableSlots({
    dateParts: { year: 2026, month: 9, day: 10 },
    durationMinutes: 60,
    requirement: { static: 1, motion: 0 },
    inventory: INVENTORY,
    allocations: [],
    openMinutes: 11 * 60,
    closeMinutes: 13 * 60,
    toUtc,
  });

  // 11:00 + 60min = 12:00 (fits); ...; 12:00 + 60min = 13:00 (fits, exactly at close); 12:15 + 60
  // = 13:15 (doesn't fit) and beyond are excluded.
  assert.deepEqual(slots, ['11:00', '11:15', '11:30', '11:45', '12:00']);
});

test('computeAvailableSlots: a slot with both static rigs already booked is excluded, its neighbors are not', () => {
  const toUtc = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(Date.UTC(year, month - 1, day, hours, minutes));

  const blockedStart = toUtc(2026, 9, 10, 12, 0);
  const blockedEnd = toUtc(2026, 9, 10, 12, 30);
  const allocations: BlockingAllocation[] = [
    { simulatorId: 's1', scheduledStartAt: blockedStart, scheduledEndAt: blockedEnd },
    { simulatorId: 's2', scheduledStartAt: blockedStart, scheduledEndAt: blockedEnd },
  ];

  const slots = computeAvailableSlots({
    dateParts: { year: 2026, month: 9, day: 10 },
    durationMinutes: 30,
    requirement: { static: 1, motion: 0 },
    inventory: INVENTORY,
    allocations,
    openMinutes: 11 * 60 + 30,
    closeMinutes: 12 * 60 + 30,
    toUtc,
  });

  assert.deepEqual(slots, ['11:30']);
});

test('computeAvailableSlots: a legacy booking with no allocation rows still removes a slot when it exhausts capacity', () => {
  const toUtc = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(Date.UTC(year, month - 1, day, hours, minutes));

  // A pre-Phase-2 Duo Static booking (2 static rigs, no booking_allocations rows) at 12:00-12:30 —
  // see allocate-simulators.ts's header. With both static rigs already legacy-claimed, a Solo
  // Static request for that same window must be excluded even though `allocations` is empty.
  const legacyBookings: LegacyBookingWindow[] = [
    {
      requirement: { static: 2, motion: 0 },
      scheduledStartAt: toUtc(2026, 9, 10, 12, 0),
      scheduledEndAt: toUtc(2026, 9, 10, 12, 30),
    },
  ];

  const slots = computeAvailableSlots({
    dateParts: { year: 2026, month: 9, day: 10 },
    durationMinutes: 30,
    requirement: { static: 1, motion: 0 },
    inventory: INVENTORY,
    allocations: [],
    legacyBookings,
    openMinutes: 11 * 60 + 30,
    closeMinutes: 12 * 60 + 30,
    toUtc,
  });

  assert.deepEqual(slots, ['11:30'], '12:00 is excluded by the legacy booking even with zero booking_allocations rows');
});

// Grand Opening launch restriction (opening-hours.ts's GRAND_OPENING_DATE/GRAND_OPENING_TIME):
// GET /availability (availability.ts) feeds computeAvailableSlots' openMinutes from
// parseTimeToMinutes(effectiveOpenTime(date)) rather than the constant OPEN_TIME — these two tests
// exercise that exact combination end-to-end, with a fully-free inventory/day so the only thing
// under test is where the enumeration starts and stops.

test('GET /availability on the Grand Opening date (2026-09-25): the earliest returned slot is 15:00, nothing before it', () => {
  const toUtc = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(Date.UTC(year, month - 1, day, hours, minutes));

  const slots = computeAvailableSlots({
    dateParts: { year: 2026, month: 9, day: 25 },
    durationMinutes: 15,
    requirement: { static: 1, motion: 0 },
    inventory: INVENTORY,
    allocations: [],
    openMinutes: parseTimeToMinutes(effectiveOpenTime('2026-09-25')),
    closeMinutes: parseTimeToMinutes(CLOSE_TIME),
    toUtc,
  });

  assert.equal(slots[0], '15:00');
  assert.ok(!slots.includes('11:00'), '11:00-14:45 must not be returned on launch day');
  assert.ok(!slots.includes('14:45'), '11:00-14:45 must not be returned on launch day');
});

test('GET /availability on the day after launch (2026-09-26): normal operating hours, earliest slot is 11:00', () => {
  const toUtc = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(Date.UTC(year, month - 1, day, hours, minutes));

  const slots = computeAvailableSlots({
    dateParts: { year: 2026, month: 9, day: 26 },
    durationMinutes: 15,
    requirement: { static: 1, motion: 0 },
    inventory: INVENTORY,
    allocations: [],
    openMinutes: parseTimeToMinutes(effectiveOpenTime('2026-09-26')),
    closeMinutes: parseTimeToMinutes(CLOSE_TIME),
    toUtc,
  });

  assert.equal(slots[0], '11:00');
});

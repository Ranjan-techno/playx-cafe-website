// Phase 2: the DB-touching half of automated simulator allocation. See simulator-allocation.ts
// for the pure algorithm this drives (requirementForProduct/pickSimulators/occupiedSimulatorIds).
//
// allocateSimulators() is the transaction/locking strategy the story asks for (item 5/6): it must
// be called after the caller has already issued BEGIN on `db` (see create-booking.ts), and it
// issues a `SELECT ... FOR UPDATE` over the *entire* simulators table before reading occupancy —
// there are only ever 4 rows, so locking all of them is cheap, and always locking them in the
// same order (ORDER BY code) rather than some subset means two concurrent transactions can never
// deadlock against each other here. Every other transaction attempting to allocate anything
// blocks on that SELECT until this one COMMITs or ROLLBACKs, so the "read occupancy, then insert"
// that follows can never race with another request's "read occupancy, then insert" — the second
// transaction only gets to read occupancy after the first has either committed its new
// booking_allocations rows (so the second sees them as occupied) or rolled back (so it doesn't).
// This is what makes two concurrent requests for the same simulator resolve to "one wins, one
// gets rejected" instead of both succeeding.
//
// Legacy-booking backward compatibility: a `bookings` row created before this feature shipped has
// no `booking_allocations` rows of its own (nothing ever backfilled them — see
// database/migrations/002_simulator_inventory.sql's header), and — because requirement-checking
// below reads only booking_allocations — would otherwise be invisible to this function and to
// availability.ts, letting a new booking be allocated on top of a still-active legacy one. The
// query below closes that gap by also counting (not id-matching — the legacy flow never recorded
// which physical rig it used) any bookings row with no booking_allocations rows against the same
// window, same as availability.ts. It reads that same booking_allocations.booking_id index this
// function already relies on (idx_booking_allocations_booking_id) to do the anti-join, and runs
// after the simulators lock below, so it's covered by the exact same serialization guarantee the
// booking_allocations occupancy read is.

import type { BlockingAllocation, LegacyBookingWindow, Requirement, SimulatorRow } from './simulator-allocation';
import { legacyReservedCounts, occupiedSimulatorIds, pickSimulators, requirementForProduct } from './simulator-allocation';

/**
 * The minimal query surface this module needs — matches the subset of pg.Client's interface
 * db.ts's getDb() already returns, so the real handler passes that client through unchanged. A
 * test passes a fake implementing just this shape instead (see lib/test-support/fake-db.ts) —
 * no mocking framework, same "small interface, hand-written fake" approach the rest of this
 * codebase uses for AWS calls (see auth-define-challenge.test.ts).
 */
export interface DbClient {
  query<T extends object = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AllocationRequest {
  bookingId: string;
  requirement: Requirement;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  /** Minutes until a fresh HOLD's hold_expires_at — the story's fixed 15 minutes, passed in
   *  rather than hardcoded here so a test can use a much shorter window. */
  holdMinutes: number;
}

export interface AllocationResult {
  simulatorIds: string[];
  holdExpiresAt: Date;
}

interface AllocationRow {
  simulator_id: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
}

interface LegacyBookingRow {
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
}

/**
 * Locks the simulator inventory, checks the requested window against every other
 * confirmed/unexpired-hold allocation, and — if the requirement can still be met — inserts one
 * 'hold' row per allocated simulator. Returns null (having allocated nothing) if inventory can't
 * cover the requirement; the caller is responsible for ROLLBACK in that case (see
 * create-booking.ts) since this function never decides whether to commit or roll back a
 * transaction it didn't open.
 *
 * Must run inside a transaction already opened by the caller (`BEGIN` already sent on `db`), with
 * `bookingId` already inserted into `bookings` in that same transaction — an allocation row
 * always references a real booking (booking_allocations.booking_id has no other purpose).
 */
export async function allocateSimulators(db: DbClient, request: AllocationRequest): Promise<AllocationResult | null> {
  // Locks all active rigs for the duration of this transaction — see this file's header for why
  // the whole table rather than just the ones this request cares about.
  const { rows: inventory } = await db.query<SimulatorRow>(
    `SELECT id, code, simulator_type FROM simulators WHERE is_active = true ORDER BY code FOR UPDATE`,
  );

  // Only allocations that actually block inventory: 'confirmed' always does; a 'hold' only while
  // its hold_expires_at hasn't passed yet — an expired HOLD is exactly what item 7 means by "must
  // not block future availability", and this filter (not a cleanup job) is what enforces that.
  const { rows: allocationRows } = await db.query<AllocationRow>(
    `SELECT simulator_id, scheduled_start_at, scheduled_end_at
     FROM booking_allocations
     WHERE scheduled_start_at < $2
       AND scheduled_end_at > $1
       AND (allocation_status = 'confirmed' OR (allocation_status = 'hold' AND hold_expires_at > now()))`,
    [request.scheduledStartAt, request.scheduledEndAt],
  );

  const blocking: BlockingAllocation[] = allocationRows.map((row) => ({
    simulatorId: row.simulator_id,
    scheduledStartAt: new Date(row.scheduled_start_at),
    scheduledEndAt: new Date(row.scheduled_end_at),
  }));
  const occupied = occupiedSimulatorIds(blocking, request.scheduledStartAt, request.scheduledEndAt);

  // Legacy bookings still occupying capacity — see this file's header. `b.id <> $3` excludes the
  // booking this very call is allocating for: create-booking.ts inserts it into `bookings` before
  // calling allocateSimulators(), so at this point it has no booking_allocations rows yet either
  // and would otherwise count itself as "legacy" demand against its own request.
  const { rows: legacyRows } = await db.query<LegacyBookingRow>(
    `SELECT simulator_type, racers, scheduled_start_at, scheduled_end_at
     FROM bookings b
     WHERE b.id <> $3
       AND b.status <> 'cancelled'
       AND b.scheduled_start_at < $2
       AND b.scheduled_end_at > $1
       AND NOT EXISTS (SELECT 1 FROM booking_allocations ba WHERE ba.booking_id = b.id)`,
    [request.scheduledStartAt, request.scheduledEndAt, request.bookingId],
  );
  const legacy: LegacyBookingWindow[] = legacyRows.map((row) => ({
    requirement: requirementForProduct({ simulatorType: row.simulator_type, racers: row.racers }),
    scheduledStartAt: new Date(row.scheduled_start_at),
    scheduledEndAt: new Date(row.scheduled_end_at),
  }));
  const reserved = legacyReservedCounts(legacy, request.scheduledStartAt, request.scheduledEndAt);

  const picked = pickSimulators(inventory, request.requirement, occupied, reserved);
  if (picked === null) {
    return null;
  }

  const holdExpiresAt = new Date(Date.now() + request.holdMinutes * 60_000);
  for (const simulator of picked) {
    await db.query(
      `INSERT INTO booking_allocations
         (booking_id, simulator_id, scheduled_start_at, scheduled_end_at, allocation_status, hold_expires_at)
       VALUES ($1, $2, $3, $4, 'hold', $5)`,
      [request.bookingId, simulator.id, request.scheduledStartAt, request.scheduledEndAt, holdExpiresAt],
    );
  }

  return { simulatorIds: picked.map((simulator) => simulator.id), holdExpiresAt };
}

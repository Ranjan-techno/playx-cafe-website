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
//
// Stage 3A.1 — ENVIRONMENT-SCOPED OCCUPANCY: S1/S2/M1/M2 are one physical inventory, but SANDBOX
// (staging/test) and PRODUCTION (live online + walk-in) bookings must never block each other.
// Every occupancy read below is therefore filtered through the owning booking's
// bookings.booking_environment (NOT NULL since migration 007): an allocation only counts against a
// request of the same environment. There are still no per-environment simulator rows and still one
// simulators lock — the lock is environment-blind on purpose, so every allocating transaction (of
// either environment) stays serialized exactly as before; only what counts as "occupied" changed.

import { assertAppEnvironment, type AppEnvironment } from './environment';
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

export interface AllocationRequest extends CapacityQuery {
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
 * Step 1 of every capacity decision (booking creation, checkout start, late-payment confirmation,
 * admin confirmation): locks ALL active simulators, always in `ORDER BY code`, for the rest of the
 * transaction. This is the single serialization point for simulator capacity — see this file's
 * header. Re-locking within the same transaction is a no-op in Postgres.
 */
export async function lockSimulatorInventory(db: DbClient): Promise<SimulatorRow[]> {
  const { rows } = await db.query<SimulatorRow>(
    `SELECT id, code, simulator_type FROM simulators WHERE is_active = true ORDER BY code FOR UPDATE`,
  );
  return rows;
}

export interface CapacityQuery {
  /** The booking this query is for — excluded from the legacy-booking demand count. */
  bookingId: string;
  requirement: Requirement;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  /** Whose occupancy counts: only allocations/legacy bookings whose booking_environment equals
   *  this. Always the booking's own (server-side) environment, never request data. */
  environment: AppEnvironment;
}

/**
 * Every allocation that currently blocks inventory in `environment` and overlaps [start, end):
 * 'confirmed' always; 'hold' only while hold_expires_at > now() (database clock). Scoped through
 * the owning booking's booking_environment — see this file's header. Shared by
 * findAvailableSimulators() (under the simulators lock) and GET /availability (read-only).
 */
export async function loadBlockingAllocations(
  db: DbClient,
  start: Date,
  end: Date,
  environment: AppEnvironment,
): Promise<BlockingAllocation[]> {
  const env = assertAppEnvironment(environment, 'environment');
  const { rows } = await db.query<AllocationRow>(
    `SELECT ba.simulator_id, ba.scheduled_start_at, ba.scheduled_end_at
     FROM booking_allocations ba
     JOIN bookings b ON b.id = ba.booking_id
     WHERE ba.scheduled_start_at < $2
       AND ba.scheduled_end_at > $1
       AND (ba.allocation_status = 'confirmed' OR (ba.allocation_status = 'hold' AND ba.hold_expires_at > now()))
       AND b.booking_environment = $3`,
    [start, end, env],
  );
  return rows.map((row) => ({
    simulatorId: row.simulator_id,
    scheduledStartAt: new Date(row.scheduled_start_at),
    scheduledEndAt: new Date(row.scheduled_end_at),
  }));
}

/**
 * Legacy (pre-Phase-2, allocation-less) bookings in `environment` overlapping [start, end) — see
 * this file's header. `excludeBookingId` (or null for none) is the booking currently being
 * allocated, which has no allocation rows of its own yet either.
 */
export async function loadLegacyBookingWindows(
  db: DbClient,
  start: Date,
  end: Date,
  environment: AppEnvironment,
  excludeBookingId: string | null,
): Promise<LegacyBookingWindow[]> {
  const env = assertAppEnvironment(environment, 'environment');
  const { rows } = await db.query<LegacyBookingRow>(
    `SELECT simulator_type, racers, scheduled_start_at, scheduled_end_at
     FROM bookings b
     WHERE b.id IS DISTINCT FROM $3::uuid
       AND b.status <> 'cancelled'
       AND b.scheduled_start_at < $2
       AND b.scheduled_end_at > $1
       AND b.booking_environment = $4
       AND NOT EXISTS (SELECT 1 FROM booking_allocations ba WHERE ba.booking_id = b.id)`,
    [start, end, excludeBookingId, env],
  );
  return rows.map((row) => ({
    requirement: requirementForProduct({ simulatorType: row.simulator_type, racers: row.racers }),
    scheduledStartAt: new Date(row.scheduled_start_at),
    scheduledEndAt: new Date(row.scheduled_end_at),
  }));
}

/**
 * Step 2: reads occupancy for the window and picks free simulator(s) for the requirement, or
 * returns null. MUST run after lockSimulatorInventory() in the same transaction (that lock is what
 * makes this read-then-write race-free). Only confirmed allocations and unexpired holds block; an
 * expired hold never does.
 */
export async function findAvailableSimulators(
  db: DbClient,
  inventory: SimulatorRow[],
  request: CapacityQuery,
): Promise<SimulatorRow[] | null> {
  // Only allocations that actually block inventory ('confirmed', or an unexpired 'hold' — an
  // expired HOLD is filtered out by the query, not by a cleanup job) and only in the request's own
  // environment. The booking being allocated is excluded from the legacy count: create-booking.ts
  // inserts it before calling allocateSimulators(), so it has no allocation rows yet either.
  const blocking = await loadBlockingAllocations(db, request.scheduledStartAt, request.scheduledEndAt, request.environment);
  const occupied = occupiedSimulatorIds(blocking, request.scheduledStartAt, request.scheduledEndAt);

  const legacy = await loadLegacyBookingWindows(
    db,
    request.scheduledStartAt,
    request.scheduledEndAt,
    request.environment,
    request.bookingId,
  );
  const reserved = legacyReservedCounts(legacy, request.scheduledStartAt, request.scheduledEndAt);

  return pickSimulators(inventory, request.requirement, occupied, reserved);
}

/** Inserts one allocation row per simulator. `holdExpiresAt` non-null -> 'hold'; null ->
 *  'confirmed' (booking_allocations_hold_expiry_chk ties the two together). */
export async function insertAllocations(
  db: DbClient,
  bookingId: string,
  simulators: SimulatorRow[],
  scheduledStartAt: Date,
  scheduledEndAt: Date,
  holdExpiresAt: Date | null,
): Promise<void> {
  for (const simulator of simulators) {
    if (holdExpiresAt) {
      await db.query(
        `INSERT INTO booking_allocations
           (booking_id, simulator_id, scheduled_start_at, scheduled_end_at, allocation_status, hold_expires_at)
         VALUES ($1, $2, $3, $4, 'hold', $5)`,
        [bookingId, simulator.id, scheduledStartAt, scheduledEndAt, holdExpiresAt],
      );
    } else {
      await db.query(
        `INSERT INTO booking_allocations
           (booking_id, simulator_id, scheduled_start_at, scheduled_end_at, allocation_status, hold_expires_at)
         VALUES ($1, $2, $3, $4, 'confirmed', NULL)`,
        [bookingId, simulator.id, scheduledStartAt, scheduledEndAt],
      );
    }
  }
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
  const inventory = await lockSimulatorInventory(db);
  const picked = await findAvailableSimulators(db, inventory, request);
  if (picked === null) {
    return null;
  }

  const holdExpiresAt = new Date(Date.now() + request.holdMinutes * 60_000);
  await insertAllocations(db, request.bookingId, picked, request.scheduledStartAt, request.scheduledEndAt, holdExpiresAt);

  return { simulatorIds: picked.map((simulator) => simulator.id), holdExpiresAt };
}

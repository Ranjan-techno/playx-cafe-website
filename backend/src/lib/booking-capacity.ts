// The ONE place a pending booking's simulator capacity is turned into a confirmed allocation.
// Used by confirmSuccessfulPayment() (a PhonePe payment succeeded) and by the admin
// pending -> confirmed transition, so neither can ever confirm an expired hold over another
// booking (the old confirmBookingAllocations()-only path flipped HOLD -> confirmed without asking
// whether the hold was still ours).
//
// LOCK ORDER (global, for every transaction that touches these tables):
//   payment  ->  booking  ->  simulators (all active, ORDER BY code)  ->  booking_allocations
// The caller must already hold the booking row lock (and the payment lock, if it has one) in an
// open transaction. This function then takes the simulators lock — the same lock create-booking
// takes via allocateSimulators() — so a late confirmation and a brand-new booking for the same
// slot are strictly serialized; whichever runs second sees the other's committed rows.

import { findAvailableSimulators, insertAllocations, lockSimulatorInventory, type DbClient } from './allocate-simulators';
import { confirmBookingAllocations, lockAllocationsForBooking, releaseHeldAllocations } from './payment-repository';
import { requirementForProduct } from './simulator-allocation';

export interface CapacityBooking {
  id: string;
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
}

export type CapacityOutcome =
  /** The booking's own holds were still valid (or it was already confirmed); now confirmed. */
  | { kind: 'held' }
  /** Holds had expired; capacity was still free, so fresh CONFIRMED allocation(s) were written.
   *  `sameSimulators` is true when the original rig(s) were free again. */
  | { kind: 'reallocated'; previousSimulatorIds: string[]; simulatorIds: string[]; sameSimulators: boolean }
  /** Holds had expired and the requirement can no longer be met. Obsolete holds are released (in
   *  this transaction) so they cannot block anyone; NOTHING is confirmed. The caller decides
   *  whether to commit that state (payment path) or roll back (admin path). */
  | { kind: 'unavailable'; previousSimulatorIds: string[] };

export async function secureBookingCapacity(db: DbClient, booking: CapacityBooking): Promise<CapacityOutcome> {
  const inventory = await lockSimulatorInventory(db);
  const rows = await lockAllocationsForBooking(db, booking.id);

  const holds = rows.filter((row) => row.allocation_status === 'hold');
  const hasConfirmed = rows.some((row) => row.allocation_status === 'confirmed');
  const previousSimulatorIds = holds.map((row) => row.simulator_id);

  if (holds.length > 0 && holds.every((row) => !row.hold_expired)) {
    await confirmBookingAllocations(db, booking.id);
    return { kind: 'held' };
  }

  // No usable hold from here on: either it expired, or there was none.
  if (holds.length > 0) {
    await releaseHeldAllocations(db, booking.id);
  }
  if (hasConfirmed) {
    // Already holds confirmed capacity (e.g. confirmed earlier); nothing to add, nothing to steal.
    return { kind: 'held' };
  }

  const start = new Date(booking.scheduled_start_at);
  const end = new Date(booking.scheduled_end_at);
  const picked = await findAvailableSimulators(db, inventory, {
    bookingId: booking.id,
    requirement: requirementForProduct({ simulatorType: booking.simulator_type, racers: booking.racers }),
    scheduledStartAt: start,
    scheduledEndAt: end,
  });
  if (picked === null) {
    return { kind: 'unavailable', previousSimulatorIds };
  }

  await insertAllocations(db, booking.id, picked, start, end, null);
  const simulatorIds = picked.map((simulator) => simulator.id);
  const sameSimulators =
    previousSimulatorIds.length === simulatorIds.length &&
    [...previousSimulatorIds].sort().join() === [...simulatorIds].sort().join();
  return { kind: 'reallocated', previousSimulatorIds, simulatorIds, sameSimulators };
}

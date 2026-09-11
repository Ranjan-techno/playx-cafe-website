// A hand-written in-memory stand-in for the subset of pg.Client admin-repository.ts's
// transitionBookingStatus() needs (bookings.id/status, booking_allocations.booking_id/
// allocation_status/hold_expires_at) — same "light regex on the SQL text, not a real parser"
// approach as test-support/fake-db.ts and test-support/fake-payment-db.ts, and reusing fake-db.ts's
// Mutex for per-booking FOR UPDATE locking.

import type { DbClient } from '../allocate-simulators';
import { Mutex } from './fake-db';

export interface FakeAdminBookingRow {
  id: string;
  status: string;
}

export interface FakeAdminAllocationRow {
  id: string;
  booking_id: string;
  allocation_status: 'hold' | 'confirmed' | 'released';
  hold_expires_at: Date | null;
}

export interface FakeAdminDbStore {
  bookings: FakeAdminBookingRow[];
  allocations: FakeAdminAllocationRow[];
  bookingLocks: Map<string, Mutex>;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function createFakeAdminDbStore(): FakeAdminDbStore {
  return { bookings: [], allocations: [], bookingLocks: new Map() };
}

export function seedAdminBooking(
  store: FakeAdminDbStore,
  input: { id?: string; status: string },
): FakeAdminBookingRow {
  const booking: FakeAdminBookingRow = { id: input.id ?? nextId('booking'), status: input.status };
  store.bookings.push(booking);
  return booking;
}

export function seedAdminAllocation(
  store: FakeAdminDbStore,
  input: { bookingId: string; status: 'hold' | 'confirmed' | 'released'; holdExpiresAt?: Date | null },
): FakeAdminAllocationRow {
  const allocation: FakeAdminAllocationRow = {
    id: nextId('alloc'),
    booking_id: input.bookingId,
    allocation_status: input.status,
    hold_expires_at: input.status === 'hold' ? (input.holdExpiresAt ?? new Date(Date.now() + 15 * 60_000)) : null,
  };
  store.allocations.push(allocation);
  return allocation;
}

function getOrCreateLock(map: Map<string, Mutex>, key: string): Mutex {
  let mutex = map.get(key);
  if (!mutex) {
    mutex = new Mutex();
    map.set(key, mutex);
  }
  return mutex;
}

function clone<T>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

export function createFakeAdminDbClient(store: FakeAdminDbStore): DbClient {
  let heldLockReleases: (() => void)[] = [];
  let snapshot: { bookings: FakeAdminBookingRow[]; allocations: FakeAdminAllocationRow[] } | null = null;

  function releaseLocks(): void {
    for (const release of heldLockReleases) {
      release();
    }
    heldLockReleases = [];
  }

  async function query<T extends object>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();

    if (/^BEGIN/i.test(sql)) {
      snapshot = { bookings: clone(store.bookings), allocations: clone(store.allocations) };
      return { rows: [] };
    }
    if (/^COMMIT/i.test(sql)) {
      snapshot = null;
      releaseLocks();
      return { rows: [] };
    }
    if (/^ROLLBACK/i.test(sql)) {
      if (snapshot) {
        store.bookings = snapshot.bookings;
        store.allocations = snapshot.allocations;
        snapshot = null;
      }
      releaseLocks();
      return { rows: [] };
    }

    // SELECT id, status FROM bookings WHERE id = $1 FOR UPDATE
    if (/^SELECT id, status FROM bookings\b/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [id] = params as [string];
      const row = store.bookings.find((b) => b.id === id);
      if (row) {
        heldLockReleases.push(await getOrCreateLock(store.bookingLocks, id).acquire());
      }
      return { rows: (row ? [{ ...row }] : []) as unknown as T[] };
    }

    // UPDATE bookings SET status = $2 WHERE id = $1
    if (/^UPDATE bookings\b/i.test(sql)) {
      const [id, status] = params as [string, string];
      const row = store.bookings.find((b) => b.id === id);
      if (row) {
        row.status = status;
      }
      return { rows: [] };
    }

    // confirmBookingAllocations (payment-repository.ts, reused by transitionBookingStatus() for a
    // pending -> confirmed transition): UPDATE booking_allocations SET allocation_status =
    // 'confirmed', hold_expires_at = NULL WHERE booking_id = $1 AND allocation_status = 'hold'
    // Matched on the SET clause specifically — the release query's WHERE clause also contains
    // the substring 'confirmed' (allocation_status IN ('hold', 'confirmed')), so matching
    // anywhere in the SQL text would misfire on that query too.
    if (/^UPDATE booking_allocations\b/i.test(sql) && /SET allocation_status = 'confirmed'/i.test(sql)) {
      const [bookingId] = params as [string];
      for (const allocation of store.allocations) {
        if (allocation.booking_id === bookingId && allocation.allocation_status === 'hold') {
          allocation.allocation_status = 'confirmed';
          allocation.hold_expires_at = null;
        }
      }
      return { rows: [] };
    }

    // UPDATE booking_allocations SET allocation_status = 'released', hold_expires_at = NULL WHERE
    // booking_id = $1 AND allocation_status IN ('hold', 'confirmed')
    if (/^UPDATE booking_allocations\b/i.test(sql) && /SET allocation_status = 'released'/i.test(sql)) {
      const [bookingId] = params as [string];
      for (const allocation of store.allocations) {
        if (
          allocation.booking_id === bookingId &&
          (allocation.allocation_status === 'hold' || allocation.allocation_status === 'confirmed')
        ) {
          allocation.allocation_status = 'released';
          allocation.hold_expires_at = null;
        }
      }
      return { rows: [] };
    }

    throw new Error(`FakeAdminDbClient: unhandled query: ${sql}`);
  }

  return { query };
}

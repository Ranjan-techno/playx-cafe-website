// A hand-written in-memory stand-in for the subset of pg.Client that allocate-simulators.ts
// (DbClient) needs, used only by *.test.ts files. There's no real Postgres available to run
// against in this repo (no docker/testcontainers dependency, no CI database — see backend/
// package.json's plain `node --import tsx --test`), so this is what lets
// allocate-simulators.test.ts exercise the *real* production allocateSimulators() function —
// not a reimplementation of it — under genuine concurrent async races, including its actual
// transaction/locking strategy, instead of only testing the pure algorithm in
// simulator-allocation.ts.
//
// It understands exactly the handful of statements create-booking.ts/allocate-simulators.ts
// issue (matched by a light regex on the SQL text, not a real parser) — nothing more.

import type { DbClient } from '../allocate-simulators';
import type { SimulatorRow } from '../simulator-allocation';

/** A minimal async mutex: models one Postgres row lock held for the lifetime of a transaction.
 *  Callers acquire() before reading/writing the locked rows and call the returned release()
 *  from COMMIT/ROLLBACK — see FakeDbClient's BEGIN/COMMIT/ROLLBACK handling below. */
class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];

  acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

export interface FakeAllocationRow {
  id: string;
  booking_id: string;
  simulator_id: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  allocation_status: 'hold' | 'confirmed' | 'released';
  hold_expires_at: Date | null;
}

/** A pre-Phase-2 `bookings` row — seeded directly (never via the fake's INSERT INTO bookings
 *  handling below, which always represents a Phase-2-era booking about to get real allocation
 *  rows) to exercise allocate-simulators.ts's legacy-booking query. See that file's header. */
export interface FakeLegacyBookingRow {
  id: string;
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
}

export interface FakeDbStore {
  simulators: (SimulatorRow & { is_active: boolean })[];
  bookings: { id: string }[];
  allocations: FakeAllocationRow[];
  legacyBookings: FakeLegacyBookingRow[];
  simulatorLock: Mutex;
}

let idCounter = 0;
/** Monotonic, collision-free across concurrent fake "connections" — JS is single-threaded, so
 *  this increment can never interleave with another call to it. */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** One store per test — a fresh, isolated in-memory "database". */
export function createFakeDbStore(seedSimulators: SimulatorRow[]): FakeDbStore {
  return {
    simulators: seedSimulators.map((simulator) => ({ ...simulator, is_active: true })),
    bookings: [],
    allocations: [],
    legacyBookings: [],
    simulatorLock: new Mutex(),
  };
}

/**
 * One fake "connection" against `store` — call this once per concurrent caller (real pg.Client
 * connections are likewise one-per-caller; only the underlying store, i.e. the database, is
 * shared). Each client tracks its own held lock so COMMIT/ROLLBACK on *this* client releases only
 * the lock *this* client's transaction acquired.
 */
export function createFakeDbClient(store: FakeDbStore): DbClient {
  let heldLockRelease: (() => void) | null = null;

  async function query<T extends object>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();

    if (/^BEGIN/i.test(sql)) {
      return { rows: [] };
    }
    if (/^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
      if (heldLockRelease) {
        heldLockRelease();
        heldLockRelease = null;
      }
      return { rows: [] };
    }

    if (/FROM simulators/i.test(sql)) {
      if (/FOR UPDATE/i.test(sql)) {
        // Mirrors real Postgres: this call blocks until no other transaction holds the lock.
        heldLockRelease = await store.simulatorLock.acquire();
      }
      const rows = store.simulators
        .filter((simulator) => simulator.is_active)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ id, code, simulator_type }) => ({ id, code, simulator_type }));
      return { rows: rows as unknown as T[] };
    }

    // Checked before the booking_allocations occupancy query below: this query's own NOT EXISTS
    // clause contains the literal text "FROM booking_allocations", which a looser/greedy check
    // for that query (matched anywhere in the string) would wrongly catch first.
    if (/^SELECT .* FROM bookings b\b/is.test(sql)) {
      // allocate-simulators.ts's legacy-booking query — see its header. Mirrors the real SQL's
      // "no allocation rows of its own, not cancelled, window-overlapping, not this call's own
      // booking" filter entirely in JS rather than parsing the query text.
      const [start, end, excludeBookingId] = params as [Date, Date, string];
      const rows = store.legacyBookings.filter(
        (booking) =>
          booking.id !== excludeBookingId &&
          booking.status !== 'cancelled' &&
          booking.scheduled_start_at < end &&
          booking.scheduled_end_at > start &&
          !store.allocations.some((allocation) => allocation.booking_id === booking.id),
      );
      return {
        rows: rows.map(({ simulator_type, racers, scheduled_start_at, scheduled_end_at }) => ({
          simulator_type,
          racers,
          scheduled_start_at,
          scheduled_end_at,
        })) as unknown as T[],
      };
    }

    if (/^SELECT .* FROM booking_allocations\b/is.test(sql)) {
      const [start, end] = params as [Date, Date];
      const now = new Date();
      const rows = store.allocations.filter(
        (allocation) =>
          allocation.scheduled_start_at < end &&
          allocation.scheduled_end_at > start &&
          (allocation.allocation_status === 'confirmed' ||
            (allocation.allocation_status === 'hold' &&
              allocation.hold_expires_at !== null &&
              allocation.hold_expires_at > now)),
      );
      return { rows: rows as unknown as T[] };
    }

    if (/^INSERT INTO bookings/i.test(sql)) {
      const id = nextId('booking');
      store.bookings.push({ id });
      return { rows: [{ id }] as unknown as T[] };
    }

    if (/^INSERT INTO booking_allocations/i.test(sql)) {
      const [bookingId, simulatorId, start, end, holdExpiresAt] = params as [string, string, Date, Date, Date];
      store.allocations.push({
        id: nextId('alloc'),
        booking_id: bookingId,
        simulator_id: simulatorId,
        scheduled_start_at: start,
        scheduled_end_at: end,
        allocation_status: 'hold',
        hold_expires_at: holdExpiresAt,
      });
      return { rows: [] };
    }

    throw new Error(`FakeDbClient: unhandled query: ${sql}`);
  }

  return { query };
}

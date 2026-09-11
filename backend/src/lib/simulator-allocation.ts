// Phase 2: automated simulator availability and allocation — the pure, DB-free half.
//
// Deliberately has no import of pg/db.ts: everything here is plain data-in/data-out logic (which
// simulator(s) a product needs, which of a given inventory+occupancy satisfy that, which start
// times in a day are free), so it's unit-testable without a real Postgres connection — same
// separation as opening-hours.ts (pure) vs db.ts (connection management). The DB-touching half
// that locks/queries/inserts against booking_allocations lives in allocate-simulators.ts, which
// imports from here.

export type SimulatorType = 'static' | 'motion';

export interface SimulatorRow {
  id: string;
  code: string;
  simulator_type: SimulatorType;
}

/** How many rigs of each type one booking needs. */
export interface Requirement {
  static: number;
  motion: number;
}

export interface ProductAllocationShape {
  simulatorType: SimulatorType | null;
  racers: number;
}

/**
 * Derives a simulator requirement from a session product's own columns (products.simulator_type/
 * racers, see database/migrations/001_initial_schema.sql) rather than hardcoding it per
 * product_code — so a future product (a new duration/price tier of an existing shape) needs no
 * change here.
 *
 * Matches the story's PHYSICAL INVENTORY table exactly:
 *   Solo Static (simulatorType: 'static', racers: 1)  -> 1 static
 *   Solo Motion (simulatorType: 'motion', racers: 1)   -> 1 motion
 *   Duo Static  (simulatorType: 'static', racers: 2)   -> 2 static
 *   Duo Motion  (simulatorType: 'motion', racers: 2)   -> 2 motion
 *   Grand Race  (simulatorType: null,     racers: 4)   -> 2 static + 2 motion (all 4 rigs)
 */
export function requirementForProduct(product: ProductAllocationShape): Requirement {
  if (product.simulatorType === 'static') {
    return { static: product.racers, motion: 0 };
  }
  if (product.simulatorType === 'motion') {
    return { static: 0, motion: product.racers };
  }
  // simulatorType === null: today only the Grand Race (racers: 4) has this shape among session
  // products — see 001_initial_schema.sql's products_type_shape_chk (a race_pass row is never
  // passed here; callers filter to product_type = 'session' first).
  if (product.racers === 4) {
    return { static: 2, motion: 2 };
  }
  throw new Error(
    `Cannot derive a simulator requirement for simulatorType=null, racers=${product.racers} — only racers=4 (Grand Race) is a known null-simulatorType session shape`,
  );
}

export interface BlockingAllocation {
  simulatorId: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

/** Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd). Exported for
 *  legacyReservedCounts below, which needs the same overlap rule against bookings rather than
 *  booking_allocations rows. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Simulator ids occupied during [start, end), given a list of allocations already filtered to
 * "blocking" ones — i.e. the caller has already applied the "confirmed, or an unexpired hold"
 * rule (see allocate-simulators.ts's SQL and availability.ts's SQL, which both filter this same
 * way at the query level so this function never has to know about "now").
 */
export function occupiedSimulatorIds(allocations: BlockingAllocation[], start: Date, end: Date): Set<string> {
  const ids = new Set<string>();
  for (const allocation of allocations) {
    if (overlaps(allocation.scheduledStartAt, allocation.scheduledEndAt, start, end)) {
      ids.add(allocation.simulatorId);
    }
  }
  return ids;
}

/**
 * A pre-Phase-2 booking (see allocate-simulators.ts/availability.ts: any `bookings` row with no
 * matching `booking_allocations` rows, which — because every post-Phase-2 booking gets its
 * allocation rows inserted in the same transaction as the booking itself — can only mean a row
 * that predates this feature) still occupies physical simulator capacity for its window, but
 * never a *specific* simulator id: the pre-Phase-2 flow never recorded which physical rig a
 * booking used (see 001_initial_schema.sql's "no simulator/rig id" note), so there is nothing to
 * put in occupiedSimulatorIds' per-id Set. `requirement` here is derived the same way a live
 * booking's is (requirementForProduct), but from the *booking's own* snapshot columns
 * (simulator_type/racers), not the product row — a legacy booking must still count correctly even
 * if its product was later deactivated or its price/terms changed.
 */
export interface LegacyBookingWindow {
  requirement: Requirement;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

/**
 * Total static/motion capacity consumed by legacy bookings (see LegacyBookingWindow above) whose
 * window overlaps [start, end). This is capacity-only — it reduces how many free rigs of a type
 * pickSimulators believes are available, without ever claiming a specific simulator id, since the
 * legacy data can't support that claim. See pickSimulators' `reserved` parameter.
 */
export function legacyReservedCounts(legacy: LegacyBookingWindow[], start: Date, end: Date): Requirement {
  const reserved: Requirement = { static: 0, motion: 0 };
  for (const booking of legacy) {
    if (overlaps(booking.scheduledStartAt, booking.scheduledEndAt, start, end)) {
      reserved.static += booking.requirement.static;
      reserved.motion += booking.requirement.motion;
    }
  }
  return reserved;
}

/**
 * The allocation algorithm: deterministically picks the lowest-code free simulator(s) of each
 * type needed to satisfy `requirement` out of `inventory`, given the already-occupied ids for the
 * slot in question. Returns null if the requirement can't be met (not enough free rigs of one or
 * both types) — this is the "reject: unavailable" case (e.g. Duo Static when only one Static rig
 * is free, or a second Solo Static once both Static rigs are already taken).
 *
 * Picking "lowest code first" (S1 before S2, M1 before M2) rather than e.g. randomly just makes
 * the outcome deterministic and easy to reason about/test; nothing depends on *which* specific
 * free rig gets chosen.
 *
 * `reserved` (default: none) additionally shrinks the free-count of each type by a legacy-booking
 * capacity claim (see legacyReservedCounts) that isn't tied to a specific id — it can never change
 * *which* rig gets picked (that's still always the lowest-code rig not in `occupied`), only
 * whether enough of them exist to satisfy `requirement` at all.
 */
export function pickSimulators(
  inventory: SimulatorRow[],
  requirement: Requirement,
  occupied: ReadonlySet<string>,
  reserved: Requirement = { static: 0, motion: 0 },
): SimulatorRow[] | null {
  const pickOfType = (type: SimulatorType, count: number, reservedCount: number): SimulatorRow[] | null => {
    if (count === 0) {
      return [];
    }
    const free = inventory
      .filter((simulator) => simulator.simulator_type === type && !occupied.has(simulator.id))
      .sort((a, b) => a.code.localeCompare(b.code));
    if (free.length - reservedCount < count) {
      return null;
    }
    return free.slice(0, count);
  };

  const staticPicks = pickOfType('static', requirement.static, reserved.static);
  if (staticPicks === null) {
    return null;
  }
  const motionPicks = pickOfType('motion', requirement.motion, reserved.motion);
  if (motionPicks === null) {
    return null;
  }
  return [...staticPicks, ...motionPicks];
}

/** Whether `requirement` can be satisfied for [start, end), given the full inventory, the
 *  allocations blocking that day (already filtered to "confirmed or unexpired hold"), and any
 *  legacy bookings (see LegacyBookingWindow) whose capacity claim isn't tied to a specific rig. */
export function isSlotAvailable(
  inventory: SimulatorRow[],
  requirement: Requirement,
  allocations: BlockingAllocation[],
  start: Date,
  end: Date,
  legacy: LegacyBookingWindow[] = [],
): boolean {
  const occupied = occupiedSimulatorIds(allocations, start, end);
  const reserved = legacyReservedCounts(legacy, start, end);
  return pickSimulators(inventory, requirement, occupied, reserved) !== null;
}

// Candidate start times are enumerated every 15 minutes — the shortest session duration in the
// catalog (js/pricing-config.js's "Quick Race", 15 min) — rather than per-product duration, so
// e.g. a 30-minute Pro Race can still start at :15 past the hour, not just on the hour.
export const SLOT_STEP_MINUTES = 15;

export interface SlotComputationInput {
  dateParts: { year: number; month: number; day: number };
  durationMinutes: number;
  requirement: Requirement;
  inventory: SimulatorRow[];
  /** Allocations already filtered to "blocking" (confirmed, or hold with an unexpired
   *  hold_expires_at) — see occupiedSimulatorIds's doc comment. May span more than just this one
   *  day; only those overlapping a given candidate slot are considered. */
  allocations: BlockingAllocation[];
  /** Legacy bookings (see LegacyBookingWindow) whose capacity claim isn't tied to a specific rig.
   *  Defaults to none. May span more than just this one day; only those overlapping a given
   *  candidate slot are considered. */
  legacyBookings?: LegacyBookingWindow[];
  openMinutes: number;
  closeMinutes: number;
  /** Converts IST wall-clock date+time parts to the UTC Date they represent — pass
   *  opening-hours.ts's istPartsToUtcDate. Injected (not imported) to keep this module free of
   *  any implicit "now"/timezone dependency, so a test can pass a trivial stand-in. */
  toUtc: (year: number, month: number, day: number, hours: number, minutes: number) => Date;
  stepMinutes?: number;
}

/**
 * Every start time (as "HH:MM") at `stepMinutes` granularity within [openMinutes, closeMinutes)
 * where the full `durationMinutes` session both finishes by closing time and has enough free
 * simulator inventory. This is GET /availability's real logic (see availability.ts) — kept pure
 * and DB-free here so it's directly unit-testable against hand-built inventory/allocations.
 */
export function computeAvailableSlots(input: SlotComputationInput): string[] {
  const step = input.stepMinutes ?? SLOT_STEP_MINUTES;
  const slots: string[] = [];

  for (
    let startMinutes = input.openMinutes;
    startMinutes + input.durationMinutes <= input.closeMinutes;
    startMinutes += step
  ) {
    const hours = Math.floor(startMinutes / 60);
    const minutes = startMinutes % 60;
    const start = input.toUtc(input.dateParts.year, input.dateParts.month, input.dateParts.day, hours, minutes);
    const end = new Date(start.getTime() + input.durationMinutes * 60_000);

    if (isSlotAvailable(input.inventory, input.requirement, input.allocations, start, end, input.legacyBookings ?? [])) {
      slots.push(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
    }
  }

  return slots;
}

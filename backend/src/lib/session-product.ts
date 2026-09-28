// The one "is this product code a bookable session?" lookup, shared by POST /bookings(/production)
// (handlers/create-booking.ts) and POST /admin/bookings/walk-in (lib/walk-in-booking.ts), so an
// online booking and a walk-in accept exactly the same products with exactly the same errors.
//
// Everything a booking snapshots — racers, duration, simulator type, list price — comes from the
// row returned here, never from the request.

import type { DbClient } from './allocate-simulators';

export interface SessionProductRow {
  id: string;
  product_code: string;
  name: string;
  product_type: 'session' | 'race_pass';
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  duration_minutes: number;
  price_inr: string; // pg returns NUMERIC as a string
  is_active: boolean;
}

export type SessionProductLookup =
  | { ok: true; product: SessionProductRow }
  | { ok: false; statusCode: 400 | 404; error: 'product_not_found' | 'product_inactive' | 'product_not_bookable'; message: string };

export async function loadBookableSessionProduct(db: DbClient, productCode: string): Promise<SessionProductLookup> {
  const { rows } = await db.query<SessionProductRow>(
    `SELECT id, product_code, name, product_type, simulator_type, racers, duration_minutes, price_inr, is_active
     FROM products
     WHERE product_code = $1`,
    [productCode],
  );
  const product = rows[0];
  if (!product) {
    return { ok: false, statusCode: 404, error: 'product_not_found', message: `No product with code "${productCode}"` };
  }
  if (!product.is_active) {
    return { ok: false, statusCode: 400, error: 'product_inactive', message: `Product "${productCode}" is not currently bookable` };
  }
  if (product.product_type !== 'session') {
    return {
      ok: false,
      statusCode: 400,
      error: 'product_not_bookable',
      message: `Product "${productCode}" cannot be booked as a session`,
    };
  }
  return { ok: true, product };
}

import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';

// Story 2.6: GET /products — the public product catalog behind the booking flow.
//
// Public: no JWT authorizer on this route (see infra/lib/constructs/api.ts). Returns only
// is_active = true products — nothing a customer could actually book is hidden, and nothing
// shown is unbookable.
//
// Bundled directly from this file by infra/lib/constructs/api.ts via NodejsFunction, same as
// health.ts — there's no separate backend build/deploy step (see backend/package.json).

interface ProductRow {
  product_code: string;
  name: string;
  product_type: 'session' | 'race_pass';
  simulator_type: 'static' | 'motion' | null;
  racers: number | null;
  duration_minutes: number | null;
  price_inr: string; // pg returns NUMERIC as a string
  credit_value_inr: string | null;
  validity_days: number | null;
}

export const handler: APIGatewayProxyHandlerV2 = async () => {
  try {
    const db = await getDb();
    const { rows } = await db.query<ProductRow>(
      `SELECT product_code, name, product_type, simulator_type, racers, duration_minutes,
              price_inr, credit_value_inr, validity_days
       FROM products
       WHERE is_active = true
       ORDER BY product_code`,
    );

    const products = rows.map((row) => ({
      productCode: row.product_code,
      name: row.name,
      productType: row.product_type,
      simulatorType: row.simulator_type,
      racers: row.racers,
      durationMinutes: row.duration_minutes,
      priceInr: Number(row.price_inr),
      creditValueInr: row.credit_value_inr === null ? null : Number(row.credit_value_inr),
      validityDays: row.validity_days,
    }));

    return jsonResponse(200, { products });
  } catch (err) {
    resetDb();
    console.error('GET /products failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load products');
  }
};

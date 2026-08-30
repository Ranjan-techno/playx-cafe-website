import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

// Story 2.6: shared response shape for the products/booking Lambdas — matches health.ts's flat
// JSON style (no envelope, no top-level "success" boolean).

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * `error` is a short, stable, machine-readable code (e.g. "invalid_request", "product_not_found")
 * a client can branch on; `message` is a human-readable sentence for logs/debugging. Never
 * combined into one field so the two can evolve independently.
 */
export function errorResponse(statusCode: number, error: string, message: string): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(statusCode, { error, message });
}

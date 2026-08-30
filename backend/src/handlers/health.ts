import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

// Story 2.5: GET /health — the first Play X backend API route.
//
// Deliberately stateless: no PostgreSQL connection (see infra/lib/constructs/database.ts),
// no Secrets Manager lookup, nothing that can fail because a downstream dependency isn't
// reachable. This route only proves the Lambda + API Gateway HTTP API wiring itself works;
// wiring it to the Story 2.2 database is a later story.
//
// Bundled directly from this file by infra/lib/constructs/api.ts via NodejsFunction — there's
// no separate backend build/deploy step (see backend/package.json).
export const handler: APIGatewayProxyHandlerV2 = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'ok', service: 'playx-api' }),
});

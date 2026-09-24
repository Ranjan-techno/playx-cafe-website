import { createHandler, defaultDeps } from './payment-status';

// PhonePe cutover Stage 2C: GET /payments/production/{bookingId}/status
// (playx-dev-payment-status-production) — the PRODUCTION twin of GET /payments/{bookingId}/status,
// ready for the frontend's final tester-enablement switch (payment-return.html is unchanged in this
// stage).
//
// Same Cognito JWT authorizer and the same payment-status.ts implementation (ownership in SQL,
// reconcile an open attempt through reconcilePayment() -> applyProviderOutcome() ->
// confirmSuccessfulPayment(), then report what the DATABASE says), with PRODUCTION hard-coded here:
// a non-PRODUCTION booking is a 404 and only payment_environment = PRODUCTION rows are ever
// reconciled or reported. Its provider comes from the production PhonePe secret only (the only one
// its IAM role can read), and the loader cross-checks it against PHONEPE_ENVIRONMENT=PRODUCTION.
// Nothing in the request can change the environment.
export const handler = createHandler(defaultDeps, { environment: 'PRODUCTION' });

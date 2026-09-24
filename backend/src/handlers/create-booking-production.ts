import { createBookingHandler } from './create-booking';

// POST /bookings/production — the PRODUCTION twin of POST /bookings (create-booking.ts), for
// bookings that will be paid through the live PhonePe environment. Same Cognito JWT authorizer,
// same validation/pricing/schedule rules, same shared simulator inventory. It differs in three
// server-side ways: the booking_environment literal below is hard-coded PRODUCTION; the Lambda's
// BOOKING_CREATE_ENABLED kill switch; and the production access gate (lib/production-access.ts —
// TESTER mode admits only allowlisted Cognito subs, PUBLIC mode any authenticated customer).
// Nothing in the request (body, headers, Origin, hostname) can choose or override any of these.
export const handler = createBookingHandler('PRODUCTION');

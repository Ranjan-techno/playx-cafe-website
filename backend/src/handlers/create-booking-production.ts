import { createBookingHandler } from './create-booking';

// POST /bookings/production — the PRODUCTION twin of POST /bookings (create-booking.ts), for
// bookings that will be paid through the live PhonePe environment. Same Cognito JWT authorizer,
// same validation/pricing/schedule rules, same shared simulator inventory. It differs in three
// server-side ways: the booking_environment literal below is hard-coded PRODUCTION; during PhonePe
// cutover Stages 2A-2C this Lambda is intentionally deployed with BOOKING_CREATE_ENABLED=false, so
// it rejects every booking; and (Stage 2C) once that switch is later turned on, only Cognito subs
// on the production tester allowlist may book (createBookingHandler's PRODUCTION gate). Nothing in
// the request (body, headers, Origin, hostname) can choose or override any of these.
export const handler = createBookingHandler('PRODUCTION');

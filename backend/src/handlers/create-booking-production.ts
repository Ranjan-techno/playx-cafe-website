import { createBookingHandler } from './create-booking';

// POST /bookings/production — the PRODUCTION twin of POST /bookings (create-booking.ts), for
// bookings that will be paid through the live PhonePe environment. Same Cognito JWT authorizer,
// same validation/pricing/schedule rules, same shared simulator inventory. It differs in three
// server-side ways: the booking_environment literal below is hard-coded PRODUCTION; during PhonePe
// cutover Stages 2A-2C this Lambda was deployed with BOOKING_CREATE_ENABLED=false, so it rejected
// every booking; and (Stage 2C) with the switch on — as from Stage 2D — only Cognito subs on the
// production tester allowlist may book (createBookingHandler's PRODUCTION gate). Nothing in the
// request (body, headers, Origin, hostname) can choose or override any of these.
export const handler = createBookingHandler('PRODUCTION');

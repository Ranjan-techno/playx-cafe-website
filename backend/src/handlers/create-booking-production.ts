import { createBookingHandler } from './create-booking';

// POST /bookings/production — the PRODUCTION twin of POST /bookings (create-booking.ts), for
// bookings that will be paid through the live PhonePe environment. Same Cognito JWT authorizer,
// same validation/pricing/schedule rules, same shared simulator inventory. It differs in two
// server-side ways: the booking_environment literal below is hard-coded PRODUCTION, and during
// PhonePe cutover Stage 2A this Lambda is intentionally deployed with BOOKING_CREATE_ENABLED=false,
// so it rejects every booking. Nothing in the request (body, headers, Origin, hostname) can choose
// or override either behavior.
export const handler = createBookingHandler('PRODUCTION');

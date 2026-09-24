import { createListMyBookingsHandler } from './list-my-bookings';

// GET /bookings/production/me — the PRODUCTION twin of GET /bookings/me (list-my-bookings.ts), used
// by playxcafe.com / www.playxcafe.com. Same Cognito JWT authorizer and owner scoping; only
// bookings whose booking_environment is PRODUCTION are ever returned. The environment is this
// server-side literal, never request data.
export const handler = createListMyBookingsHandler('PRODUCTION');

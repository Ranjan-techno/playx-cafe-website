import { createAvailabilityHandler } from './availability';

// GET /availability/production — the PRODUCTION twin of GET /availability (availability.ts), used by
// playxcafe.com / www.playxcafe.com. Public like its SANDBOX twin; counts only PRODUCTION occupancy
// (live online bookings + walk-ins), never staging/test holds. The environment is this server-side
// literal, never request data.
export const handler = createAvailabilityHandler('PRODUCTION');

// Stage 2G: the SES message-tag contract shared by the sender (lib/ses.ts) and the delivery-event
// consumer (lib/booking-email-events.ts). Deliberately dependency-free and side-effect-free: lib/ses.ts
// is also bundled into the OTP CreateAuthChallenge Lambda, and importing the consumer module from
// there would pull its top-level initializers into that bundle. Keep this file a bare constant.

/** The SES message tag carrying booking_notifications.id — the ONLY tag lib/ses.ts adds, and the
 *  correlation key in booking-email-events.ts. An internal UUID: never an address, name, phone,
 *  Cognito sub or note. */
export const NOTIFICATION_ID_TAG = 'playx_notification_id';

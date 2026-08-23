// ============================================================================
// Membership config - the ONLY file you need to edit to set or change
// membership tiers. js/membership.js reads this and builds the Membership
// section on index.html automatically - the HTML never needs to be touched.
//
// Launch is intentionally capped at two tiers: PLAY X MEMBER and PLAY X PRO.
// Do not add more tiers here without also revisiting the section design -
// it's built around exactly two cards side by side.
//
// Per tier, fill in:
//
//   fee              - membership fee in INR (number). Leave `null` until
//                       decided - the card shows "Membership fee to be
//                       announced" instead of a number.
//   validity         - how long the membership lasts, as plain text
//                       (e.g. "1 month", "3 months", "1 year"). Leave `null`
//                       to omit it - it's only shown alongside a real fee.
//   racingBenefits   - array of racing-related perks (e.g. bonus session
//                       minutes, discounted sessions). Add/remove array
//                       entries freely; each becomes one bullet on the card.
//   memberPricing    - one line describing this tier's session pricing
//                       (e.g. how it relates to the Static/Motion rates in
//                       js/pricing-config.js).
//   bookingPriority  - one line describing this tier's booking priority.
//   cafeBenefits     - array of cafe/hangout perks. Same as racingBenefits.
//   highlight        - true for the tier that should be visually emphasized
//                       (e.g. a slightly stronger border). Purely a design
//                       flag - it does not add any "Most Popular"-style
//                       marketing copy, since that's a business decision.
//
// Every bracketed value below (e.g. "[Racing benefit]") is a placeholder -
// replace the bracketed text with the real benefit/fee/etc. Leave the
// surrounding array/object structure as-is so the card keeps rendering
// correctly.
// ============================================================================

const MEMBERSHIP_CONFIG = [
  {
    id: 'member',
    name: 'PLAY X MEMBER',
    tagline: '[One-line description of this tier]',
    fee: null,
    validity: null,
    racingBenefits: [
      '[Racing benefit]'
    ],
    memberPricing: '[Member session pricing details]',
    bookingPriority: '[Booking priority details]',
    cafeBenefits: [
      '[Cafe benefit]'
    ],
    highlight: false
  },
  {
    id: 'pro',
    name: 'PLAY X PRO',
    tagline: '[One-line description of this tier]',
    fee: null,
    validity: null,
    racingBenefits: [
      '[Racing benefit]'
    ],
    memberPricing: '[Member session pricing details]',
    bookingPriority: '[Booking priority details]',
    cafeBenefits: [
      '[Cafe benefit]'
    ],
    highlight: true
  }
];

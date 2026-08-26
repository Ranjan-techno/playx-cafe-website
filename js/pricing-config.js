// ============================================================================
// Pricing config - the ONLY file you need to edit to set or change simulator
// session pricing. js/pricing.js reads this and builds the Pricing section on
// index.html automatically - the HTML never needs to be touched.
//
// This is also the source of truth for the booking form's Xperience and
// Simulator Type selectors (see SIMULATOR_TYPES and PRICING_GROUPS[].racers
// below, and js/script.js) - add/rename a simulator type or experience group
// here and the booking form stays in sync automatically.
//
// When a real backend/API exists, PRICING_POLICY/PRICING_GROUPS/
// SIMULATOR_TYPES/SESSION_BENEFITS are the shape a pricing endpoint should
// return - js/pricing.js only cares about this shape, not where it comes
// from, so swapping this file for a fetch() call later is a small change.
//
// SIMULATOR_TYPES
//   The two simulator types available to book, id + display name. Used by
//   the booking form dropdown.
//
// PRICING_POLICY
//   Shared pricing-policy copy shown under the section heading (tax-inclusive
//   note, same-rate-every-day note). Edit the wording here, not in index.html.
//
// PRICING_GROUPS
//   Ordered array of experience groups, rendered top to bottom. Each group is
//   one of two shapes (set via `kind`):
//
//   kind: 'matrix'
//     A set of duration options, each priced separately for Static and
//     Motion (Solo Racing Xperience, Race Together). Fields per group:
//       title       - group heading
//       racers      - number of racers this group is for (used by the
//                     booking form to auto-fill racer count - it never asks
//                     the customer to choose)
//       groupNote   - optional line shown under the title (e.g. clarifying
//                     that a price is for multiple racers, not per racer)
//       options[]   - { name, durationMinutes, staticPrice, motionPrice,
//                       badge (optional short tag, e.g. "Most Popular") }
//
//   kind: 'signature'
//     A single flagship experience with one flat price per duration, never
//     split into Static/Motion columns (the Grand Race). The booking form
//     also skips asking Static vs Motion for this kind - it uses all
//     simulators. Fields per group:
//       name        - product name shown as the card heading
//       racers      - number of racers this group is for (see above)
//       meta        - one descriptive line (e.g. racer/simulator/track count)
//       options[]   - { durationMinutes, price }
//
// SESSION_BENEFITS
//   Flat list of perks included with every eligible session, rendered as a
//   small secondary block under the pricing groups.
//
// All prices are in INR and already include applicable taxes (see
// PRICING_POLICY.taxNote) - never render a price elsewhere as tax-exclusive.
// There is deliberately no weekday/weekend/surge split - one rate applies on
// every operating day (see PRICING_POLICY.rateNote).
// ============================================================================

const SIMULATOR_TYPES = [
  { id: 'static', name: 'Static Simulator' },
  { id: 'motion', name: 'Motion Simulator' }
];

const PRICING_POLICY = {
  taxNote: 'All prices include applicable taxes.',
  rateNote: 'Same rates on all operating days.'
};

const PRICING_GROUPS = [
  {
    id: 'solo',
    kind: 'matrix',
    title: 'Solo Racing Xperience',
    racers: 1,
    options: [
      { id: 'quick', name: 'Quick Race', durationMinutes: 15, staticPrice: 399, motionPrice: 599 },
      { id: 'pro', name: 'Pro Race', durationMinutes: 30, staticPrice: 599, motionPrice: 999, badge: 'Most Popular' },
      { id: 'endurance', name: 'Endurance', durationMinutes: 60, staticPrice: 999, motionPrice: 1799 }
    ]
  },
  {
    id: 'duo',
    kind: 'matrix',
    title: 'Race Together',
    racers: 2,
    groupNote: 'Price is for the 2-racer Duo Xperience, not per racer.',
    options: [
      { id: 'duo-15', name: 'Duo Xperience — 2 Racers', durationMinutes: 15, staticPrice: 699, motionPrice: 1099 },
      { id: 'duo-30', name: 'Duo Xperience — 2 Racers', durationMinutes: 30, staticPrice: 1099, motionPrice: 1799 }
    ]
  },
  {
    id: 'grand-race',
    kind: 'signature',
    title: 'Signature Group Xperience',
    name: 'PLAY X GRAND RACE',
    racers: 4,
    meta: '4 Racers | 4 Simulators | One Track | One Winner',
    options: [
      { durationMinutes: 15, price: 1799 },
      { durationMinutes: 30, price: 2799 }
    ]
  }
];

const SESSION_BENEFITS = [
  'Official lap timing',
  'Personal best',
  'Daily ranking',
  'Weekly leaderboard'
];

// ============================================================================
// Pricing config - the ONLY file you need to edit to set or change simulator
// pricing. js/pricing.js reads this and builds the Pricing section on
// index.html automatically - the HTML never needs to be touched.
//
// There are two categories, matching the two simulator types (2 machines
// each). For each one, fill in whichever fields you have final numbers for:
//
//   sessionDurationMinutes  - length of one session, in minutes (e.g. 30)
//   weekdayPrice            - price in INR for one session, Tue-Fri
//   weekendPrice            - price in INR for one session, Sat-Sun
//   memberPrice             - price in INR for members (any day)
//
// Leave a field as `null` if that value isn't decided yet - it's simply left
// off the pricing card instead of showing a blank or a placeholder number.
// If every field for a category is still `null`, that card shows a plain
// "Pricing coming soon" message instead. So it's always safe to publish this
// file, even before every price is finalized.
//
// Example, once real numbers are ready:
//   sessionDurationMinutes: 30,
//   weekdayPrice: 500,
//   weekendPrice: 600,
//   memberPrice: 450,
// ============================================================================

const PRICING_CONFIG = [
  {
    id: 'static',
    name: 'Static Simulator',
    machinesAvailable: 2,
    sessionDurationMinutes: null,
    weekdayPrice: null,
    weekendPrice: null,
    memberPrice: null
  },
  {
    id: 'motion',
    name: 'Motion Simulator',
    machinesAvailable: 2,
    sessionDurationMinutes: null,
    weekdayPrice: null,
    weekendPrice: null,
    memberPrice: null
  }
];

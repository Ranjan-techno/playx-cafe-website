// ============================================================================
// Race Pass config - the ONLY file you need to edit to set or change Play X
// Race Pass (and any future prepaid racing-credit or membership product).
// js/race-pass.js reads this and builds the Race Pass section on index.html
// automatically - the HTML never needs to be touched.
//
// RACE_PASS_PRODUCTS is an array, even though there is only one product at
// launch, so a future pass can be added later (e.g. a higher-value pass, a
// corporate pass) by adding another object here - the renderer and
// index.html do not need to change, the new product just becomes another
// card in the section.
//
// When a real backend/API exists, this array is the shape a Race Pass
// endpoint should return - js/race-pass.js only cares about this shape, not
// where it comes from, so swapping this file for a fetch() call later is a
// small change.
//
// Per product, fill in:
//   name            - product name, shown as the card heading
//   price           - amount the customer pays, in INR
//   creditValue     - total racing-credit value they receive, in INR. The
//                     bonus (creditValue - price) is shown as a plain "bonus
//                     credit" line, not as a crossed-out/fake discount.
//   validityDays    - how many days the credits remain valid after purchase
//   rules           - array of plain-text rule bullets (how credits can be
//                     used, Driver ID linkage, cafe purchases, etc.)
//   highlight       - true to visually emphasize this product's card
// ============================================================================

const RACE_PASS_PRODUCTS = [
  {
    id: 'play-x-race-pass',
    name: 'PLAY X RACE PASS',
    price: 2499,
    creditValue: 2799,
    validityDays: 90,
    rules: [
      'Credits can be used on Static or Motion racing sessions',
      "Linked to the customer's Driver ID",
      'Cafe purchases are billed separately'
    ],
    highlight: true
  }
];

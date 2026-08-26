# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Play X Cafe — a marketing/landing site for a car-racing-simulator cafe in Bengaluru, plus a Firebase-backed
login/signup page. It is a static site: plain HTML, CSS, and vanilla JS, with no build step, no bundler, no
package manager, and no test suite.

## Running it locally

There is no dev server or build command. Open `index.html` directly in a browser, or serve the directory with
any static file server, e.g.:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.

## File structure and how the pages relate

- `index.html` — the single-page marketing site. All sections (About, Simulators, Gallery, Pricing, Race Pass,
  Academy, Pro Shop, Events, Terms, Location, Booking) live in one file as `<section id="...">` blocks and are
  linked to from the nav via anchor hashes (`#pricing`, `#booking`, etc.). Placeholder content (address, phone,
  email, prices) is marked with bracketed text like `[ADDRESS LINE 1]`, `[PHONE NUMBER]` — replace these with
  real values rather than treating them as final copy.
- `auth.html` — standalone Log In / Sign Up page (tabs, not separate routes) reached via `auth.html?mode=login`
  or `auth.html?mode=signup` from the header buttons on `index.html`.
- `css/style.css` — one shared stylesheet for both pages, organized in commented sections (Header, Hero, About,
  Features, Gallery, Pricing, Race Pass, Academy, Shop, Events, Terms, Location, Booking form, Footer, Auth
  page, Responsive). Design tokens (colors, fonts, radius) are CSS custom properties on `:root` at the top —
  change the palette/typography there rather than hardcoding values elsewhere. Two breakpoints: 900px (nav
  collapses to hamburger) and 600px (grids collapse to single column).
- `js/pricing-config.js` — the only file to edit to change simulator session pricing (durations, Static/Motion
  rates for Solo Racing Xperience, Race Together, and the Grand Race signature experience), the pricing-policy
  copy (tax-inclusive/same-rate-every-day note), the session benefits list, and `SIMULATOR_TYPES` (the source
  for the booking form's Simulator Type dropdown, see `js/script.js`). `js/pricing.js` reads it and renders the
  Pricing section (`#pricingGroups`, `#pricingPolicyNote`, `#sessionBenefits`) on `index.html` — the HTML never
  needs to change to update a price.
- `js/race-pass-config.js` — the only file to edit to change or add Play X Race Pass products (a prepaid
  racing-credit product, not a membership tier). `RACE_PASS_PRODUCTS` is an array so a future second product can
  be added without touching the renderer or `index.html`. `js/race-pass.js` reads it and renders the Race Pass
  section (`#racePassGrid`). (This pair of files was renamed from `membership-config.js`/`membership.js` when
  the "Membership" concept was replaced by the single-product Race Pass at launch.)
- `js/firebase-config.js` — Firebase project config, loaded on both pages before the other scripts. Ships with
  placeholder keys (`YOUR_API_KEY` etc.); `isFirebaseConfigured` is computed by checking whether the API key was
  replaced. Every other auth-related script checks this flag and degrades to a "not configured yet" status
  message instead of throwing when it's false.
- `js/auth.js` — drives `auth.html`: tab switching between Log In/Sign Up, Firebase email/password and
  Google/Apple popup sign-in, password reset, and the post-auth "success" panel that redirects to `index.html`.
  Maps Firebase error codes to user-facing copy via `ERROR_MESSAGES`.
- `js/site-auth-state.js` — runs on `index.html` (not on `auth.html`) to swap the header's Log In/Sign Up links
  for a "Hi, {name}" greeting + Log Out button when a Firebase session exists, via `onAuthStateChanged`. Applies
  to both `#desktopAuthArea` and `#mobileAuthRow` header regions. No-ops entirely if Firebase isn't configured.
- `js/script.js` — `index.html`-only behavior: mobile nav toggle, populating the booking form's Simulator Type
  dropdown from `js/pricing-config.js`'s `SIMULATOR_TYPES`, and the booking form submit handler, which currently
  only logs to console and shows a client-side confirmation message (no backend/API call is wired up — see the
  `TODO` comment there before assuming bookings are actually captured anywhere).

## Firebase auth setup

Sign-in is inert until `js/firebase-config.js` has real project keys. Setup steps are documented inline in that
file's header comment: create a Firebase project, register a web app, copy the config values in, then enable
Email/Password and Google sign-in methods under Authentication in the Firebase console (Apple sign-in
additionally needs a paid Apple Developer account, noted in `auth.js` near the Apple button handler). Firebase
JS SDK is loaded via CDN `<script>` tags (compat build, v10.14.1) directly in `index.html`/`auth.html` — there's
no npm package for it in this project.

The signup form collects a phone number, but Firebase Authentication only persists name/email/password — the
phone number is currently discarded (see the `NOTE` comment in `auth.js`). Wire up Firestore or another store if
that needs to be saved.

## Conventions to preserve when editing

- Sections in `index.html` are separated by `<!-- ============ NAME ============ -->` banner comments — keep
  this style for any new section.
- CSS is a single flat file, not per-component — add new rules under the relevant commented section rather than
  starting a new stylesheet.
- SVGs used for icons/illustrations are hand-authored inline in the HTML (no icon library/sprite sheet).
- No frameworks, no module system (`type="module"` isn't used) — scripts are plain global-scope `<script>` tags
  loaded in a fixed order; keep new JS consistent with that (no bundler to resolve imports).

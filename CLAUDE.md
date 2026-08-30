# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Play X Cafe — a marketing/landing site for a car-racing-simulator cafe in Chennai, plus a login/signup page and
a booking flow backed by a real AWS backend (Cognito, API Gateway, Lambda, RDS PostgreSQL). The site itself
(`index.html`, `auth.html`, `css/`, `js/`) is still a static site: plain HTML, CSS, and vanilla JS, with no build
step, no bundler, no package manager, and no test suite — it's meant to keep working unmodified on GitHub Pages.
The backend is a separate CDK app in `infra/` (deploying `backend/`'s Lambda handlers and `database/`'s SQL
migrations) with its own build/deploy tooling; see "AWS backend setup" below and `infra/README.md`.

## Running it locally

There is no dev server or build command. Open `index.html` directly in a browser, or serve the directory with
any static file server, e.g.:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/`.

## File structure and how the pages relate

- `index.html` — the single-page marketing site. All sections (About, Simulators, Gallery, Pricing, Race Pass,
  Academy, Pro Shop, Events, Terms, Location, Booking, My Bookings) live in one file as `<section id="...">`
  blocks and are linked to from the nav via anchor hashes (`#pricing`, `#booking`, etc.). Placeholder content (address, phone,
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
  needs to change to update a price. Each bookable option also carries a `*ProductCode` field (e.g.
  `staticProductCode: 'solo-pro-static'`) matching a `product_code` row in `database/migrations/`'s seed data —
  this is what `js/script.js` sends as `POST /bookings`' `productCode`, and what `js/product-lookup.js` maps
  back to a label. Never add or rename one here without a matching row in that seed data.
- `js/race-pass-config.js` — the only file to edit to change or add Play X Race Pass products (a prepaid
  racing-credit product, not a membership tier). `RACE_PASS_PRODUCTS` is an array so a future second product can
  be added without touching the renderer or `index.html`. `js/race-pass.js` reads it and renders the Race Pass
  section (`#racePassGrid`). (This pair of files was renamed from `membership-config.js`/`membership.js` when
  the "Membership" concept was replaced by the single-product Race Pass at launch.)
- `js/aws-config.js` — AWS backend config (Cognito region/User Pool ID/App Client ID, API Gateway base URL),
  loaded on both pages before the other AWS-related scripts. Ships with placeholder values (`YOUR_USER_POOL_ID`
  etc.) filled in from the `cdk deploy` outputs described in "AWS backend setup" below; `isAwsConfigured` is
  computed by checking whether they were replaced. Every auth/booking script checks this flag and degrades to a
  "not configured yet" status message instead of throwing when it's false — same pattern the old
  `js/firebase-config.js` used.
- `js/cognito-auth.js` — a small promise-based wrapper around the `amazon-cognito-identity-js` UMD bundle
  (loaded via CDN `<script>`, same approach as the Firebase SDK before it), exposing `CognitoAuth` (signUp,
  confirmSignUp, resendConfirmationCode, signIn, signOut, forgotPassword, confirmPassword, getSession,
  isLoggedIn, getAccessToken, getIdTokenClaims). Loaded on both pages before `js/auth.js`/`js/site-auth-state.js`/
  `js/script.js`/`js/my-bookings.js`, all of which are Cognito clients of this one file rather than talking to
  the SDK directly. Persistent auth state comes from the SDK's own localStorage-backed session storage plus this
  file's `getSession()` transparently refreshing expired tokens — no extra code needed for that.
- `js/auth.js` — drives `auth.html`: tab switching between Log In/Sign Up/Verify Email/Reset Password, Cognito
  sign-up + email-verification-code confirmation, sign-in, forgot-password (code + new password), and the
  post-auth "success" panel that redirects to `index.html` (or to `sessionStorage`'s `pxPostLoginRedirect`, if
  `js/script.js` set one before sending an unauthenticated visitor here to log in). Maps Cognito exception names
  to user-facing copy via `ERROR_MESSAGES`. The Google/Apple buttons stay in the markup but are not wired to
  anything — the Cognito User Pool client has no Hosted UI/identity providers configured (see
  `infra/lib/constructs/auth.ts`) — clicking one just shows a "not available yet" status message.
- `js/site-auth-state.js` — runs on `index.html` (not on `auth.html`) to swap the header's Log In/Sign Up links
  for My Account/Log Out when a valid Cognito session exists (checked once via `CognitoAuth.getSession()` on
  load — there's no Firebase-style `onAuthStateChanged` listener, so Log Out does a full page reload rather than
  live-updating the header). My Account links to the new `#my-bookings` section. Applies to both
  `#desktopAuthArea` and `#mobileAuthArea` header regions. No-ops entirely if AWS isn't configured.
- `js/product-lookup.js` — maps a backend `productCode` (e.g. `"solo-pro-motion"`) back to a human-readable
  Xperience label, built from `js/pricing-config.js`'s `PRICING_GROUPS`. The booking API only ever returns the
  code, never a display name (see `backend/src/handlers/`), so `js/script.js`'s booking result and
  `js/my-bookings.js`'s list both go through this to show something readable.
- `js/my-bookings.js` — renders the `#my-bookings` section on `index.html`: `GET /bookings/me` (Bearer the
  Cognito access token) for the signed-in customer, or a "log in to view your bookings" gate otherwise. Also
  exposes `refreshMyBookings()`, which `js/script.js` calls right after a successful booking so the list updates
  without a page reload.
- `js/script.js` — `index.html`-only behavior: mobile nav toggle, populating the booking form's Simulator Type
  dropdown from `js/pricing-config.js`'s `SIMULATOR_TYPES`, and the booking form submit handler. Booking requires
  a signed-in Cognito session — the form is hidden behind a login gate (`#bookingLoginGate`) until one exists —
  and submits `POST /bookings` with only `{ productCode, bookingDate, startTime, notes }` (Name/Phone/Email in
  the form are for the venue's own contact purposes and aren't sent; `productCode` is resolved from the
  Xperience/Simulator selection via the `*ProductCode` fields in `js/pricing-config.js`). The price shown in the
  form is a preview only — never sent to, or trusted from, the browser; the backend always looks the current
  price up itself. The returned booking (Xperience, Date, Time, Price, Status) is shown in `#bookingResult`.

## AWS backend setup

Sign-in, booking, and My Bookings are all inert until `js/aws-config.js` has real values. Deploy the backend
first (`cd infra && npm install && npx cdk deploy` — see `infra/README.md`), then copy three CloudFormation
outputs from that deploy into `js/aws-config.js`: `Auth...UserPoolIdOutput...` → `userPoolId`,
`Auth...WebClientIdOutput...` → `userPoolClientId`, and `Api...UrlOutput...` → `apiBaseUrl`. `region` matches
`infra/lib/config/environment-config.ts`'s `environments.dev.region` (`ap-south-1` by default). None of these
are secrets — a Cognito User Pool ID/App Client ID and an API Gateway URL are public identifiers safe to embed
in browser JS, same trust level as the old `firebaseConfig.apiKey`. No AWS account credentials or database
credentials belong in frontend JS (or anywhere in this repo outside Secrets Manager) — the Lambda handlers in
`backend/src/handlers/` are the only thing that talks to RDS, via a Secrets Manager-held credential.

Auth itself is Amazon Cognito (`infra/lib/constructs/auth.ts`), called from the browser via the
`amazon-cognito-identity-js` CDN bundle (SRP auth — the User Pool's app client has no client secret and only
`ALLOW_USER_SRP_AUTH` enabled, so the password itself never goes over the wire). See `js/cognito-auth.js` for
the wrapper and `js/auth.js`/`js/site-auth-state.js` for how the pages use it. There's no Hosted UI or identity
provider configured, so the Google/Apple buttons on `auth.html` aren't wired to anything (see `js/auth.js`).

The signup form collects a phone number, but the Cognito User Pool only persists name/email/password — the
phone number is currently discarded (see the `NOTE` comment in `js/cognito-auth.js`'s `signUp()`; it's not
required or auto-verified, and the field is free-text, not guaranteed valid E.164). Extending the User Pool
schema with a custom attribute (or storing it in RDS alongside the booking) is a separate change.

CORS: `infra/lib/config/api-config.ts`'s dev config allows only `https://ranjan-techno.github.io` (the GitHub
Pages origin this site deploys to) to call the API. Testing this integration from `python3 -m http.server`
locally will hit CORS errors calling the deployed API unless that config is temporarily extended (and
redeployed) to include `http://localhost:8000` or whichever local origin is being used.

## Conventions to preserve when editing

- Sections in `index.html` are separated by `<!-- ============ NAME ============ -->` banner comments — keep
  this style for any new section.
- CSS is a single flat file, not per-component — add new rules under the relevant commented section rather than
  starting a new stylesheet.
- SVGs used for icons/illustrations are hand-authored inline in the HTML (no icon library/sprite sheet).
- No frameworks, no module system (`type="module"` isn't used) — scripts are plain global-scope `<script>` tags
  loaded in a fixed order; keep new JS consistent with that (no bundler to resolve imports).

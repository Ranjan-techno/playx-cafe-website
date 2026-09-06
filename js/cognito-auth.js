// Thin wrapper around amazon-cognito-identity-js, giving every other script
// (js/auth.js, js/site-auth-state.js, js/script.js, js/my-bookings.js) one
// small promise-based API instead of that library's callback style, and one
// place that knows about the Cognito User Pool itself.
//
// Requires js/aws-config.js to be loaded first (for AWS_CONFIG/isAwsConfigured)
// and the amazon-cognito-identity-js UMD bundle loaded before this file - see
// the <script> tags near the bottom of index.html/auth.html. Every function
// below is a no-op-safe no when isAwsConfigured is false (mirrors
// js/firebase-config.js's isFirebaseConfigured pattern) so callers only need
// to check CognitoAuth.isConfigured once, not before every call.
//
// Persistent auth state: CognitoUserPool is explicitly pointed at
// window.localStorage below (rather than relying on amazon-cognito-identity-js's
// own default storage detection), and every CognitoUser this file creates is
// pointed at that same object. getSession() then transparently refreshes an
// expired access/ID token using the stored refresh token. That combination is
// what makes a signed-in visitor stay signed in across page loads and browser
// restarts with no extra code here - and why every construction below must
// share the one Storage, not just the one Pool: amazon-cognito-identity-js
// keys its CognitoIdentityServiceProvider.* storage entries off Pool/Client/
// Username, but a CognitoUser built with a *different* Storage object reads
// and writes an entirely separate store, so a mismatch here silently behaves
// like storage was never persisted at all.
function cognitoStorage() {
  try {
    // Access, not just typeof-check: Safari private mode and some locked-down
    // embeds expose window.localStorage but throw on first use.
    const probeKey = '__playx_cognito_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

const COGNITO_STORAGE = isAwsConfigured ? cognitoStorage() : null;
if (isAwsConfigured && !COGNITO_STORAGE) {
  console.error('Cognito storage unavailable: window.localStorage is not usable in this browser context.');
}

const userPool =
  isAwsConfigured && COGNITO_STORAGE
    ? new AmazonCognitoIdentity.CognitoUserPool({
        UserPoolId: AWS_CONFIG.userPoolId,
        ClientId: AWS_CONFIG.userPoolClientId,
        Storage: COGNITO_STORAGE
      })
    : null;

function cognitoUserFor(email) {
  return new AmazonCognitoIdentity.CognitoUser({
    Username: email,
    Pool: userPool,
    Storage: COGNITO_STORAGE
  });
}

// Cognito's `phone_number` attribute requires strict E.164 (+<country
// code><number>, digits only) - Play X's signup form (auth.html) only ever
// collects a bare Indian mobile number, so this is deliberately narrow
// (10 digits, optionally with a leading 0 or the 91 country code already on
// it) rather than a general-purpose phone parser. Returns null for anything
// that doesn't match one of those shapes, rather than guessing.
function normalizeIndianMobileToE164(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

function signUp(name, email, password, phone) {
  return new Promise((resolve, reject) => {
    const attributes = [new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'name', Value: name })];
    // The phoneNumber attribute isn't required (infra/lib/constructs/auth.ts)
    // and the signup form's phone field is optional to send on - but if one
    // was entered, normalize it to E.164 first (see above) rather than
    // sending the raw "6383599120" a customer types, which Cognito's
    // phone_number format validation would reject outright.
    if (phone) {
      const e164Phone = normalizeIndianMobileToE164(phone);
      if (!e164Phone) {
        reject({ code: 'InvalidPhoneNumberException', message: 'Enter a valid 10-digit Indian mobile number.' });
        return;
      }
      attributes.push(new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'phone_number', Value: e164Phone }));
    }
    userPool.signUp(email, password, attributes, null, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function confirmSignUp(email, code) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).confirmRegistration(code, true, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function resendConfirmationCode(email) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).resendConfirmationCode((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function signIn(email, password) {
  return new Promise((resolve, reject) => {
    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: email, Password: password });
    cognitoUserFor(email).authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err)
    });
  });
}

function signOut() {
  const user = userPool && userPool.getCurrentUser();
  if (user) user.signOut();
}

function forgotPassword(email) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).forgotPassword({
      onSuccess: (data) => resolve(data),
      onFailure: (err) => reject(err)
    });
  });
}

function confirmPassword(email, code, newPassword) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err)
    });
  });
}

/** Resolves the current, valid session (refreshing expired tokens against the
 *  stored refresh token first), or null if nobody is signed in / the refresh
 *  token itself is gone or revoked. Never rejects - a session lookup failing
 *  is treated as "signed out", not an error the caller needs to handle. */
function getSession() {
  return new Promise((resolve) => {
    const user = userPool && userPool.getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err, session) => {
      if (err || !session || !session.isValid()) resolve(null);
      else resolve(session);
    });
  });
}

async function isLoggedIn() {
  return (await getSession()) !== null;
}

/** The Cognito access token JWT, or null if signed out. This is what
 *  Authorization: Bearer <token> carries to the API (see js/script.js /
 *  js/my-bookings.js) - the HTTP API's Cognito JWT authorizer
 *  (infra/lib/constructs/api.ts) accepts it via the token's `client_id`
 *  claim. */
async function getAccessToken() {
  const session = await getSession();
  return session ? session.getAccessToken().getJwtToken() : null;
}

/** Decoded ID token claims (name, email, ...) for prefilling UI - never used
 *  for anything security-sensitive; the API only ever trusts the "sub" claim
 *  it verifies itself from the access token. */
async function getIdTokenClaims() {
  const session = await getSession();
  return session ? session.getIdToken().decodePayload() : null;
}

// backend/src/lib/email.ts's normalizeEmail() (trim + lowercase) is what
// AdminCreateUser/AdminGetUser/AdminInitiateAuth (auth-start.ts) and
// AdminRespondToAuthChallenge (auth-verify.ts) actually use as the Cognito
// Username - so that normalized form is the ONLY version of an email
// guaranteed to match the account a passwordless /auth/verify just
// authenticated against. Mirrored here (not shared - this project has no
// build step to import backend/ code from) so installPasswordlessSession()
// below never caches a session under a differently-cased Username than the
// one Cognito itself is using.
function normalizePasswordlessEmail(email) {
  return (email || '').trim().toLowerCase();
}

/** Installs the tokens a passwordless POST /auth/verify (js/script.js's
 *  callAuthVerify() - both the booking OTP flow and the My Bookings OTP flow
 *  call this same helper afterward) returns into this same CognitoUserPool's
 *  own localStorage-backed session storage, in the exact shape
 *  amazon-cognito-identity-js expects. Once this resolves, getSession()/
 *  isLoggedIn()/getAccessToken()/getIdTokenClaims() above - and every caller
 *  of them (js/site-auth-state.js, js/my-bookings.js, js/script.js's own
 *  attemptDraftAutoCompletion()) - transparently treat the visitor as signed
 *  in, exactly as if they'd signed in with a password, with no second,
 *  incompatible session mechanism to keep track of. `authResult` is the
 *  plain { idToken, accessToken, refreshToken, expiresIn } POST /auth/verify
 *  returns; never the OTP itself, and never logged.
 *
 *  ROOT CAUSE this replaces: amazon-cognito-identity-js's own
 *  CognitoUser.cacheTokens() (called by setSignInUserSession() below)
 *  unconditionally calls signInUserSession.getRefreshToken().getToken() with
 *  no null check. The old persistSession() built the session with
 *  `RefreshToken: undefined` whenever its `tokens` argument had no
 *  refreshToken, which made cacheTokens() throw a TypeError partway through
 *  - AFTER it had already written the idToken/accessToken storage keys but
 *  BEFORE it reached the LastAuthUser key, which is the very first thing
 *  getCurrentUser() looks up. That half-written state is exactly what made
 *  the UI fall back to "verify your email" right after a verify that had, in
 *  fact, just succeeded - and because every caller wrapped this in a
 *  try/catch that either swallowed the error entirely or folded it into a
 *  generic "please try again" message, nothing ever surfaced why. This
 *  version refuses to build a session missing any of the three tokens (see
 *  the guard clause below) and never treats a caught exception as success.
 *
 *  Throws - rather than returning null - if AWS isn't configured, a token is
 *  missing, or a programmatic check right after installing it
 *  (userPool.getCurrentUser() + this same file's getSession()) can't confirm
 *  the session actually took, so a caller's own catch block sees a real
 *  failure instead of silently proceeding as if the visitor were signed in. */
async function installPasswordlessSession(email, authResult) {
  if (isAwsConfigured && !COGNITO_STORAGE) {
    throw new Error('Cognito storage unavailable.');
  }
  if (!userPool) {
    throw new Error('AWS is not configured.');
  }
  if (!authResult || !authResult.idToken || !authResult.accessToken || !authResult.refreshToken) {
    throw new Error('Sign-in did not return a complete session.');
  }

  const username = normalizePasswordlessEmail(email);
  const session = new AmazonCognitoIdentity.CognitoUserSession({
    IdToken: new AmazonCognitoIdentity.CognitoIdToken({ IdToken: authResult.idToken }),
    AccessToken: new AmazonCognitoIdentity.CognitoAccessToken({ AccessToken: authResult.accessToken }),
    RefreshToken: new AmazonCognitoIdentity.CognitoRefreshToken({ RefreshToken: authResult.refreshToken })
  });
  const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
    Username: username,
    Pool: userPool,
    Storage: COGNITO_STORAGE
  });
  cognitoUser.setSignInUserSession(session);

  // Verify programmatically rather than trusting that the call above worked
  // - see the ROOT CAUSE note. getCurrentUser() re-reads storage from
  // scratch (a fresh CognitoUser, not the one constructed above), and
  // getSession() re-derives a CognitoUserSession from whatever actually
  // landed in storage - so both together are a real end-to-end check, not
  // just re-inspecting the in-memory object just built. Each stage below
  // throws a distinct, secret-free diagnostic so a failure here says *where*
  // persistence broke instead of a single generic message.
  if (!userPool.getCurrentUser()) {
    throw new Error('Cognito current user was not cached.');
  }
  const confirmedSession = await getSession();
  if (!confirmedSession) {
    throw new Error('Cognito cached session was not valid.');
  }
  return confirmedSession;
}

const CognitoAuth = {
  isConfigured: isAwsConfigured,
  signUp,
  confirmSignUp,
  resendConfirmationCode,
  signIn,
  signOut,
  forgotPassword,
  confirmPassword,
  getSession,
  isLoggedIn,
  getAccessToken,
  getIdTokenClaims,
  installPasswordlessSession,
  normalizeIndianMobileToE164
};

// Auth page (Log In / Sign Up) - backed by Firebase Authentication.
// Requires js/firebase-config.js to be filled in with a real project (see that
// file for setup steps). Until then, every action below shows a clear
// "not configured yet" message instead of failing silently.

const auth = isFirebaseConfigured ? firebase.auth() : null;

const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const viewLogin = document.getElementById('viewLogin');
const viewSignup = document.getElementById('viewSignup');
const authFormArea = document.getElementById('authFormArea');
const authSuccess = document.getElementById('authSuccess');
const successHeadline = document.getElementById('successHeadline');
const successMessage = document.getElementById('successMessage');
const loginStatus = document.getElementById('loginStatus');
const signupStatus = document.getElementById('signupStatus');

function showAuthView(view) {
  const isLogin = view === 'login';
  viewLogin.hidden = !isLogin;
  viewSignup.hidden = isLogin;
  tabLogin.classList.toggle('active', isLogin);
  tabSignup.classList.toggle('active', !isLogin);
  tabLogin.setAttribute('aria-selected', String(isLogin));
  tabSignup.setAttribute('aria-selected', String(!isLogin));
}

// Open on whichever mode the link pointed to (?mode=login / ?mode=signup)
const initialMode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'login';
showAuthView(initialMode);

tabLogin.addEventListener('click', () => showAuthView('login'));
tabSignup.addEventListener('click', () => showAuthView('signup'));
document.getElementById('goToSignup').addEventListener('click', () => showAuthView('signup'));
document.getElementById('goToLogin').addEventListener('click', () => showAuthView('login'));

function showSuccess(headline, message, { redirect = true } = {}) {
  authFormArea.hidden = true;
  successHeadline.textContent = headline;
  successMessage.textContent = message;
  authSuccess.hidden = false;
  authSuccess.focus?.();
  if (redirect) {
    setTimeout(() => { location.href = 'index.html'; }, 1400);
  }
}

function setButtonLoading(btn, loadingText) {
  btn.disabled = true;
  btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
  btn.textContent = loadingText;
}

function resetButton(btn) {
  btn.disabled = false;
  if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
}

const NOT_CONFIGURED_MESSAGE = 'Sign-in isn\'t set up yet - add your Firebase project keys in js/firebase-config.js.';

const ERROR_MESSAGES = {
  'auth/email-already-in-use': 'That email already has an account - try logging in instead.',
  'auth/invalid-email': 'That email address looks invalid.',
  'auth/weak-password': 'Password should be at least 6 characters.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/user-not-found': 'No account found with that email.',
  'auth/too-many-requests': 'Too many attempts - please wait a bit and try again.',
  'auth/popup-closed-by-user': 'Sign-in window was closed before finishing.',
  'auth/cancelled-popup-request': 'Sign-in window was closed before finishing.',
  'auth/operation-not-allowed': 'This sign-in method isn\'t enabled yet for this project (enable it in the Firebase console).',
  'auth/invalid-api-key': NOT_CONFIGURED_MESSAGE,
  'auth/configuration-not-found': NOT_CONFIGURED_MESSAGE,
  'auth/unauthorized-domain': 'This domain isn\'t authorized yet - add it under Authentication > Settings > Authorized domains in the Firebase console.'
};

function friendlyError(error) {
  return ERROR_MESSAGES[error.code] || error.message || 'Something went wrong. Please try again.';
}

function showStatus(el, text) {
  el.textContent = text;
  el.classList.remove('success');
}

// Social auth buttons
async function handleSocialAuth(providerName, btn, statusEl) {
  if (!auth) {
    showStatus(statusEl, NOT_CONFIGURED_MESSAGE);
    return;
  }
  setButtonLoading(btn, `Connecting to ${providerName}...`);
  try {
    // NOTE: Apple sign-in additionally requires a paid Apple Developer account
    // and a Services ID configured under Authentication > Sign-in method >
    // Apple in the Firebase console - Google works with just the steps in
    // firebase-config.js.
    const provider = providerName === 'Google'
      ? new firebase.auth.GoogleAuthProvider()
      : new firebase.auth.OAuthProvider('apple.com');
    const result = await auth.signInWithPopup(provider);
    showSuccess('Welcome to Play X Cafe!', `Signed in as ${result.user.displayName || result.user.email}.`);
  } catch (err) {
    resetButton(btn);
    showStatus(statusEl, friendlyError(err));
  }
}

document.getElementById('googleLoginBtn').addEventListener('click', (e) => handleSocialAuth('Google', e.currentTarget, loginStatus));
document.getElementById('appleLoginBtn').addEventListener('click', (e) => handleSocialAuth('Apple', e.currentTarget, loginStatus));
document.getElementById('googleSignupBtn').addEventListener('click', (e) => handleSocialAuth('Google', e.currentTarget, signupStatus));
document.getElementById('appleSignupBtn').addEventListener('click', (e) => handleSocialAuth('Apple', e.currentTarget, signupStatus));

// Forgot password
document.getElementById('forgotPasswordLink').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!auth) {
    showStatus(loginStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) {
    showStatus(loginStatus, 'Enter your email above first, then click "Forgot password?" again.');
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    showStatus(loginStatus, `Password reset email sent to ${email}.`);
    loginStatus.classList.add('success');
  } catch (err) {
    showStatus(loginStatus, friendlyError(err));
  }
});

// Log in form
const loginForm = document.getElementById('loginForm');
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!auth) {
    showStatus(loginStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const btn = document.getElementById('loginSubmitBtn');
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  setButtonLoading(btn, 'Logging in...');
  try {
    await auth.signInWithEmailAndPassword(email, password);
    showSuccess('Welcome back!', `Logged in as ${email}.`);
  } catch (err) {
    resetButton(btn);
    showStatus(loginStatus, friendlyError(err));
  }
});

// Sign up form
const signupForm = document.getElementById('signupForm');
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!auth) {
    showStatus(signupStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  if (signupForm.password.value !== signupForm.confirm.value) {
    showStatus(signupStatus, 'Passwords do not match.');
    return;
  }

  const name = signupForm.name.value.trim();
  const email = signupForm.email.value.trim();
  const password = signupForm.password.value;
  const btn = document.getElementById('signupSubmitBtn');

  setButtonLoading(btn, 'Creating account...');
  try {
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    await credential.user.updateProfile({ displayName: name });
    // NOTE: phone number is collected in the form but not stored anywhere -
    // Firebase Authentication only holds name/email/password here. Add
    // Firestore (or another database) if you need to save phone numbers too.
    showSuccess(`Welcome, ${name.split(' ')[0]}!`, 'Your Play X Cafe account is ready.');
  } catch (err) {
    resetButton(btn);
    showStatus(signupStatus, friendlyError(err));
  }
});

// If already logged in, skip the forms
if (auth) {
  auth.onAuthStateChanged((user) => {
    if (user && authFormArea && !authFormArea.hidden) {
      showSuccess('You\'re already logged in', `Signed in as ${user.displayName || user.email}.`, { redirect: false });
    }
  });
} else {
  showStatus(loginStatus, NOT_CONFIGURED_MESSAGE);
  showStatus(signupStatus, NOT_CONFIGURED_MESSAGE);
}

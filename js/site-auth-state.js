// Reflects Cognito login state in the site header: shows "My Account" (a
// link to the #my-bookings section below) + "Log Out" when signed in, or the
// default Log In / Sign Up links when signed out. Requires js/aws-config.js
// to be filled in - if it isn't, the header is left as-is (default Log In /
// Sign Up links), same degrade-gracefully pattern this used with Firebase.

if (CognitoAuth.isConfigured) {
  const authAreas = [
    document.getElementById('desktopAuthArea'),
    document.getElementById('mobileAuthArea')
  ].filter(Boolean);
  const defaultHTML = new Map(authAreas.map((el) => [el, el.innerHTML]));

  function renderLoggedIn() {
    authAreas.forEach((el) => {
      // "My Account" keeps the same button treatment Log In/Sign Up had in
      // this slot. "Log Out" is deliberately not a .btn (that reads as a
      // big, bright, primary-looking action) - it's a plain subtle nav-style
      // link/button, matching the site's dark/red nav aesthetic (see
      // .logout-btn in css/style.css).
      const accountBtnClass = el.id === 'desktopAuthArea' ? 'btn btn-sm btn-text auth-btn-desktop' : 'btn btn-outline';
      el.innerHTML = `<a href="#my-bookings" class="${accountBtnClass}">My Account</a><button type="button" class="logout-btn">Log Out</button>`;
      el.querySelector('.logout-btn').addEventListener('click', () => {
        CognitoAuth.signOut();
        // No auth-state listener exists for Cognito the way Firebase's
        // onAuthStateChanged provided one, so a full reload is the simplest
        // reliable way to put every piece of UI (header, booking gate, My
        // Bookings list) back into its signed-out state together.
        location.href = 'index.html';
      });
    });
  }

  function renderLoggedOut() {
    authAreas.forEach((el) => { el.innerHTML = defaultHTML.get(el); });
  }

  CognitoAuth.getSession().then((session) => {
    if (session) renderLoggedIn();
    else renderLoggedOut();
  });
}

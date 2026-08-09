// Reflects Firebase login state in the site header: shows "Hi, {name}" + Log Out
// when signed in, or the default Log In / Sign Up links when signed out.
// Requires js/firebase-config.js to be filled in - if it isn't, the header is
// left as-is (default Log In / Sign Up links).

if (isFirebaseConfigured) {
  const auth = firebase.auth();
  const authAreas = [
    document.getElementById('desktopAuthArea'),
    document.getElementById('mobileAuthArea')
  ].filter(Boolean);
  const defaultHTML = new Map(authAreas.map(el => [el, el.innerHTML]));

  auth.onAuthStateChanged((user) => {
    authAreas.forEach((el) => {
      if (user) {
        const name = user.displayName ? user.displayName.split(' ')[0] : (user.email ? user.email.split('@')[0] : 'Racer');
        const btnSize = el.id === 'desktopAuthArea' ? 'btn btn-sm btn-outline' : 'btn btn-outline';
        el.innerHTML = `<span class="header-greeting">Hi, ${name}</span><button type="button" class="${btnSize} logout-btn">Log Out</button>`;
        el.querySelector('.logout-btn').addEventListener('click', () => auth.signOut());
      } else {
        el.innerHTML = defaultHTML.get(el);
      }
    });
  });
}

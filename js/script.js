// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const siteHeader = document.querySelector('.site-header');

navToggle.addEventListener('click', () => {
  const isOpen = siteHeader.classList.toggle('nav-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

document.querySelectorAll('.main-nav a').forEach(link => {
  link.addEventListener('click', () => {
    siteHeader.classList.remove('nav-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// Booking form - front-end only (no backend wired up yet)
const bookingForm = document.getElementById('bookingForm');
const formStatus = document.getElementById('formStatus');

bookingForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const data = Object.fromEntries(new FormData(bookingForm).entries());

  // TODO: replace with a real backend/booking API call (e.g. POST to your server,
  // a form service like Formspree, or an embedded booking platform).
  console.log('Booking request (not yet sent anywhere):', data);

  formStatus.textContent = `Thanks, ${data.name}! We've received your request for ${data.date} at ${data.time}. Our team will confirm your slot shortly.`;
  formStatus.classList.add('success');
  bookingForm.reset();
});

// Set minimum bookable date to today
const dateInput = document.getElementById('date');
if (dateInput) {
  const today = new Date().toISOString().split('T')[0];
  dateInput.setAttribute('min', today);
}

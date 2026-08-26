// Renders the Race Pass section (#racePassGrid) from
// js/race-pass-config.js.
//
// RACE_PASS_PRODUCTS is an array so a future second product (another pass,
// a membership tier, etc.) can be added without touching this renderer or
// index.html - each product just becomes one more card in the grid (see
// .race-pass-grid in css/style.css, which wraps to lay out more than one).

function formatRacePassAmount(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

function renderRacePassCard(product) {
  const bonus = product.creditValue - product.price;
  const cardClass = product.highlight ? 'race-pass-card highlight' : 'race-pass-card';

  return `
    <div class="${cardClass}" data-product="${product.id}">
      <span class="race-pass-eyebrow">Prepaid Racing Credits</span>
      <h3>${product.name}</h3>
      <div class="race-pass-value">
        <div class="race-pass-pay">
          <span>Pay</span>
          <strong>${formatRacePassAmount(product.price)}</strong>
        </div>
        <div class="race-pass-arrow" aria-hidden="true"></div>
        <div class="race-pass-get">
          <span>Get in race credits</span>
          <strong>${formatRacePassAmount(product.creditValue)}</strong>
        </div>
      </div>
      <span class="race-pass-bonus-pill">+${formatRacePassAmount(bonus)} bonus credit</span>
      <ul class="race-pass-rules">
        <li>Valid for ${product.validityDays} days</li>
        ${product.rules.map((rule) => `<li>${rule}</li>`).join('')}
      </ul>
      <a href="#booking" class="btn btn-primary btn-lg">Get Race Pass</a>
    </div>
  `;
}

const racePassGrid = document.getElementById('racePassGrid');
if (racePassGrid) {
  racePassGrid.innerHTML = RACE_PASS_PRODUCTS.map(renderRacePassCard).join('');
}

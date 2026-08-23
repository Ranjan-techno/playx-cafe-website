// Renders the Pricing section (#pricingGrid) from js/pricing-config.js.
//
// Keeps the customer-facing card deliberately simple: only rows with a real
// value are ever shown, and a category with nothing set yet falls back to a
// single "Pricing coming soon" line instead of empty fields or raw config
// values. No technical/config detail is ever exposed in the rendered markup.

function formatINR(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

function renderPricingCard(category) {
  const rows = [];
  if (category.weekdayPrice != null) rows.push(['Weekday', category.weekdayPrice]);
  if (category.weekendPrice != null) rows.push(['Weekend', category.weekendPrice]);
  if (category.memberPrice != null) rows.push(['Member', category.memberPrice]);

  const durationLine = category.sessionDurationMinutes != null
    ? `<p class="pricing-duration">${category.sessionDurationMinutes}-minute session</p>`
    : '';

  const priceBody = rows.length
    ? `<ul class="price-list">
        ${rows.map(([label, price]) => `<li><span>${label}</span><strong>${formatINR(price)}</strong></li>`).join('')}
      </ul>`
    : `<p class="pricing-soon">Pricing coming soon &mdash; contact us for availability.</p>`;

  return `
    <div class="pricing-card" data-category="${category.id}">
      <span class="pricing-machines">${category.machinesAvailable} machines available</span>
      <h3>${category.name}</h3>
      ${durationLine}
      ${priceBody}
      <a href="#booking" class="btn btn-outline">Book a Session</a>
    </div>
  `;
}

const pricingGrid = document.getElementById('pricingGrid');
if (pricingGrid) {
  pricingGrid.innerHTML = PRICING_CONFIG.map(renderPricingCard).join('');
}

// Renders the Pricing section (#pricingGroups, #pricingPolicyNote,
// #sessionBenefits) from js/pricing-config.js.
//
// Two group "kinds" are supported - see js/pricing-config.js for the exact
// shape:
//   'matrix'    - Solo Racing Xperience / Race Together: duration options,
//                 each rendered as its own card with Static/Motion shown
//                 side by side so the two prices are never ambiguous.
//   'signature' - Grand Race: a single flagship experience with one flat
//                 price per duration, never split into Static/Motion - kept
//                 visually separate as a "hero" block, not a third card in
//                 the matrix grid.
//
// No hardcoded commercial values live here or in index.html - everything
// rendered below (prices, durations, names) comes from js/pricing-config.js.
// This file only decides how that data is laid out.

function formatINR(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

function renderOptionCard(option) {
  const badge = option.badge
    ? `<span class="pricing-badge">${option.badge}</span>`
    : '';

  return `
    <div class="pricing-option-card${option.badge ? ' featured' : ''}">
      ${badge}
      <p class="pricing-option-duration">${option.durationMinutes} min</p>
      <h4 class="pricing-option-name">${option.name}</h4>
      <div class="pricing-rate-compare">
        <div class="rate-block">
          <span class="rate-label">Static</span>
          <strong class="rate-value">${formatINR(option.staticPrice)}</strong>
        </div>
        <div class="rate-divider" aria-hidden="true"></div>
        <div class="rate-block">
          <span class="rate-label">Motion</span>
          <strong class="rate-value">${formatINR(option.motionPrice)}</strong>
        </div>
      </div>
    </div>
  `;
}

function renderMatrixGroup(group) {
  const noteLine = group.groupNote
    ? `<p class="pricing-group-note">${group.groupNote}</p>`
    : '';

  return `
    <div class="pricing-group" data-group="${group.id}">
      <div class="pricing-group-head">
        <h3 class="pricing-group-title">${group.title}</h3>
        ${noteLine}
      </div>
      <div class="pricing-option-grid">${group.options.map(renderOptionCard).join('')}</div>
    </div>
  `;
}

function renderSignatureGroup(group) {
  // group.meta is one pipe-separated string in config (e.g. "4 Racers |
  // 4 Simulators | ..."); split here purely for layout - the copy itself
  // stays exactly as authored in js/pricing-config.js.
  const specs = group.meta.split('|').map((s) => s.trim()).filter(Boolean);
  const specHtml = specs.map((spec) => `<span class="signature-spec">${spec}</span>`).join('');

  const options = group.options.map((option) => `
    <div class="signature-option">
      <span>${option.durationMinutes} min</span>
      <strong>${formatINR(option.price)}</strong>
    </div>
  `).join('');

  return `
    <div class="pricing-signature" data-group="${group.id}">
      <span class="pricing-kicker-tag">${group.title}</span>
      <h3 class="pricing-signature-name">${group.name}</h3>
      <div class="signature-specs">${specHtml}</div>
      <div class="signature-options">${options}</div>
      <a href="#booking" class="btn btn-primary btn-lg">Book Grand Race</a>
    </div>
  `;
}

function renderGroup(group) {
  return group.kind === 'signature' ? renderSignatureGroup(group) : renderMatrixGroup(group);
}

const pricingGroupsEl = document.getElementById('pricingGroups');
if (pricingGroupsEl) {
  pricingGroupsEl.innerHTML = PRICING_GROUPS.map(renderGroup).join('');
}

const pricingPolicyEl = document.getElementById('pricingPolicyNote');
if (pricingPolicyEl) {
  pricingPolicyEl.textContent = `${PRICING_POLICY.taxNote} ${PRICING_POLICY.rateNote}`;
}

const sessionBenefitsEl = document.getElementById('sessionBenefits');
if (sessionBenefitsEl && SESSION_BENEFITS.length) {
  sessionBenefitsEl.innerHTML = `
    <p class="session-benefits-title">Every Eligible Session Includes</p>
    <div class="session-benefits-strip">
      ${SESSION_BENEFITS.map((perk) => `<span>${perk}</span>`).join('')}
    </div>
  `;
}

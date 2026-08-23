// Renders the Membership section (#membershipGrid) from
// js/membership-config.js.
//
// Keeps the customer-facing card deliberately simple: fee/validity render as
// one line (or a plain "to be announced" line if the fee isn't set yet), and
// all four benefit dimensions (racing, member pricing, booking priority,
// cafe) collapse into a single flat perk list per card - no subheadings, no
// config detail exposed. Capped at two tiers (see membership-config.js).

function formatMembershipFee(tier) {
  if (tier.fee == null) return 'Membership fee to be announced';
  const amount = '₹' + Number(tier.fee).toLocaleString('en-IN');
  return tier.validity ? `${amount} <span>/ ${tier.validity}</span>` : amount;
}

function renderMembershipCard(tier) {
  const perks = [
    ...tier.racingBenefits,
    tier.memberPricing,
    tier.bookingPriority,
    ...tier.cafeBenefits
  ].filter(Boolean);

  const cardClass = tier.highlight ? 'member-card highlight' : 'member-card';
  const btnClass = tier.highlight ? 'btn btn-primary' : 'btn btn-outline';
  const feeClass = tier.fee == null ? 'member-price pending' : 'member-price';

  return `
    <div class="${cardClass}" data-tier="${tier.id}">
      <h3>${tier.name}</h3>
      <p class="member-tagline">${tier.tagline}</p>
      <p class="${feeClass}">${formatMembershipFee(tier)}</p>
      <ul>
        ${perks.map((perk) => `<li>${perk}</li>`).join('')}
      </ul>
      <a href="#booking" class="${btnClass}">Join Now</a>
    </div>
  `;
}

const membershipGrid = document.getElementById('membershipGrid');
if (membershipGrid) {
  membershipGrid.innerHTML = MEMBERSHIP_CONFIG.map(renderMembershipCard).join('');
}

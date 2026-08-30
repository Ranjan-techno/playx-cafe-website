// Maps a backend `productCode` (e.g. "solo-pro-motion") back to a
// human-readable Xperience label, using js/pricing-config.js as the single
// source of truth - the API only ever returns the code (see
// backend/src/handlers/create-booking.ts / list-my-bookings.ts responses),
// never a display name, so anything that shows a booking to a customer
// (js/script.js's booking result, js/my-bookings.js) needs this to turn
// "duo-30-motion" into "Duo Xperience — 2 Racers (Motion) — 30 min".
//
// Requires js/pricing-config.js to be loaded first.

function simulatorName(id) {
  if (typeof SIMULATOR_TYPES === 'undefined') return id;
  return (SIMULATOR_TYPES.find((t) => t.id === id) || {}).name || id;
}

const PRODUCT_LABELS = (() => {
  const labels = {};
  if (typeof PRICING_GROUPS === 'undefined') return labels;

  PRICING_GROUPS.forEach((group) => {
    if (group.kind === 'matrix') {
      group.options.forEach((option) => {
        if (option.staticProductCode) {
          labels[option.staticProductCode] = `${option.name} (${simulatorName('static')}) — ${option.durationMinutes} min`;
        }
        if (option.motionProductCode) {
          labels[option.motionProductCode] = `${option.name} (${simulatorName('motion')}) — ${option.durationMinutes} min`;
        }
      });
    } else if (group.kind === 'signature') {
      group.options.forEach((option) => {
        if (option.productCode) {
          labels[option.productCode] = `${group.name} — ${option.durationMinutes} min`;
        }
      });
    }
  });

  return labels;
})();

function getProductLabel(productCode) {
  return PRODUCT_LABELS[productCode] || productCode;
}

// Same lookup as getProductLabel, but returns the Xperience name and
// Simulator type as separate fields instead of one combined string - the My
// Bookings list (js/my-bookings.js) shows "Experience" and "Simulator" as
// their own columns rather than one merged label.
function getProductDetails(productCode) {
  const fallback = { experienceName: productCode, simulatorType: '', durationMinutes: null };
  if (typeof PRICING_GROUPS === 'undefined') return fallback;

  for (const group of PRICING_GROUPS) {
    if (group.kind === 'matrix') {
      for (const option of group.options) {
        if (option.staticProductCode === productCode) {
          return { experienceName: option.name, simulatorType: simulatorName('static'), durationMinutes: option.durationMinutes };
        }
        if (option.motionProductCode === productCode) {
          return { experienceName: option.name, simulatorType: simulatorName('motion'), durationMinutes: option.durationMinutes };
        }
      }
    } else if (group.kind === 'signature') {
      for (const option of group.options) {
        if (option.productCode === productCode) {
          return { experienceName: group.name, simulatorType: 'All 4 Simulators', durationMinutes: option.durationMinutes };
        }
      }
    }
  }

  return fallback;
}

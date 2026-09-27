// DOM-free helper for js/admin.js: the compact "EMAIL" section of the Booking Detail overlay
// (Stage 2G). It reads ONLY the typed emailNotification object the admin API exposes (status,
// deliveryStatus, timestamps, sanitized failure type) — the API never sends the SES message id,
// notification id, recipient or raw SES data, and nothing here would render them.
//
//   Confirmation  outbox status: PENDING / SENT / FAILED / SUPPRESSED (or NONE if never queued)
//   Delivery      SES-reported: ACCEPTED / DELAYED / DELIVERED / BOUNCED / COMPLAINED / REJECTED /
//                 RENDERING FAILED, or NOT TRACKED for an email sent before delivery tracking
//                 (never FAILED just because tracking was absent), or — while it was never sent.
(function (root) {
  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const CONFIRMATION_LABELS = {
    pending: 'PENDING',
    sent: 'SENT',
    failed: 'FAILED',
    suppressed: 'SUPPRESSED',
  };

  const DELIVERY_LABELS = {
    accepted: 'ACCEPTED',
    delayed: 'DELAYED',
    delivered: 'DELIVERED',
    bounced: 'BOUNCED',
    complained: 'COMPLAINED',
    rejected: 'REJECTED',
    rendering_failed: 'RENDERING FAILED',
  };

  // Pill tone per state: good / wait / bad / muted (styled in css/admin.css).
  const DELIVERY_TONES = {
    accepted: 'wait',
    delayed: 'wait',
    delivered: 'good',
    bounced: 'bad',
    complained: 'bad',
    rejected: 'bad',
    rendering_failed: 'bad',
  };

  const CONFIRMATION_TONES = { pending: 'wait', sent: 'good', failed: 'bad', suppressed: 'muted' };

  function confirmationLabel(notification) {
    if (!notification) return 'NONE';
    return CONFIRMATION_LABELS[notification.status] || 'UNKNOWN';
  }

  function deliveryLabel(notification) {
    if (!notification || notification.status !== 'sent') return '—';
    if (!notification.deliveryStatus) return 'NOT TRACKED';
    return DELIVERY_LABELS[notification.deliveryStatus] || 'NOT TRACKED';
  }

  function pill(label, tone) {
    return `<span class="admin-email-pill ${tone}">${escapeText(label)}</span>`;
  }

  // formatDateTime: admin.js's IST formatter (optional; falls back to the raw ISO string).
  function emailNotificationHtml(notification, formatDateTime) {
    const fmt = typeof formatDateTime === 'function' ? formatDateTime : (v) => v;
    const confirmation = confirmationLabel(notification);
    const delivery = deliveryLabel(notification);
    const confirmationTone = notification ? CONFIRMATION_TONES[notification.status] || 'muted' : 'muted';
    const deliveryTone = notification && notification.status === 'sent' && notification.deliveryStatus
      ? DELIVERY_TONES[notification.deliveryStatus] || 'muted'
      : 'muted';

    const cells = [
      `<div><span>Confirmation</span><strong>${pill(confirmation, confirmationTone)}</strong></div>`,
      `<div><span>Delivery</span><strong>${pill(delivery, deliveryTone)}</strong></div>`,
    ];
    if (notification && notification.sentAt) {
      cells.push(`<div><span>Sent</span><strong>${escapeText(fmt(notification.sentAt))}</strong></div>`);
    }
    const eventTimes = [
      ['Delivered', notification && notification.deliveredAt],
      ['Bounced', notification && notification.bouncedAt],
      ['Complained', notification && notification.complainedAt],
    ];
    for (const [label, value] of eventTimes) {
      if (value) cells.push(`<div><span>${label}</span><strong>${escapeText(fmt(value))}</strong></div>`);
    }
    if (notification && notification.status === 'sent' && notification.deliveryStatus &&
        notification.deliveryStatus !== 'delivered' && notification.deliveryStatus !== 'accepted' &&
        notification.deliveryFailureType) {
      const reason = notification.deliveryFailureSubtype
        ? `${notification.deliveryFailureType} / ${notification.deliveryFailureSubtype}`
        : notification.deliveryFailureType;
      cells.push(`<div><span>Reason</span><strong>${escapeText(reason)}</strong></div>`);
    }
    return `<div class="admin-detail-grid">${cells.join('')}</div>`;
  }

  const api = { emailNotificationHtml, confirmationLabel, deliveryLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlayXAdminEmailStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);

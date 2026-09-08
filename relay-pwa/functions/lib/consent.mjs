// relay-pwa/functions/lib/consent.mjs
//
// SMS consent gate for messages Relay sends to a CONTRACTOR'S CUSTOMER
// (auto-forwarded invoices/quotes, and review requests).
//
// Why this exists:
//   Relay is the platform; the contractor is the sender of record. Under the
//   TCPA the defense that matters is that consent existed, so consent has to be
//   a record we can produce — not a promise in the Terms of Service. Every
//   automated text to an end customer must pass through canTextCustomer().
//
//   The contractor attests to consent when they add the customer (checkbox +
//   method + timestamp, stored on the customer doc). Numbers with no matching
//   customer record, or a record without consent, are NOT texted.
//
// This gate applies only to customer-facing messages. Replies to the
// contractor's own inbound text are not affected — they initiated that
// conversation and consented at signup.

// Normalize a phone to its last 10 digits so "(616) 248-1977", "6162481977"
// and "+16162481977" all compare equal.
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Look up the customer record for a phone number and decide whether Relay may
 * send them an automated text of a given kind.
 *
 * Scopes:
 *   'transactional' — documents about work already done (invoices, quotes).
 *   'promotional'   — review requests. Carriers commonly treat review
 *                     solicitation as marketing, a higher consent bar, so this
 *                     scope requires per-customer consent and is NOT satisfied
 *                     by a bulk attestation.
 *
 * A consent record carries smsConsentScope: 'all' for per-customer consent
 * (the contractor answered for this specific person) or 'transactional' for a
 * bulk attestation. Records written before scopes existed have no field and
 * are treated as 'all', since those were per-customer answers.
 *
 * @returns {Promise<{allowed: boolean, reason: string, customerId?: string}>}
 */
export async function canTextCustomer(db, uid, phone, requiredScope = 'transactional') {
  const key = normalizePhone(phone);
  if (!key) return { allowed: false, reason: 'invalid_phone' };

  let snap;
  try {
    snap = await db.collection('users').doc(uid).collection('customers').get();
  } catch (err) {
    console.error('[consent] customer lookup failed:', err.message);
    // Fail closed: if we cannot confirm consent, we do not send.
    return { allowed: false, reason: 'lookup_failed' };
  }

  for (const doc of snap.docs) {
    const d = doc.data();
    if (normalizePhone(d.phone) !== key && normalizePhone(d.secondaryPhone) !== key) continue;

    if (d.smsOptOut === true) {
      return { allowed: false, reason: 'opted_out', customerId: doc.id };
    }
    if (d.smsConsent === true) {
      const scope = d.smsConsentScope || 'all';
      if (requiredScope === 'promotional' && scope !== 'all') {
        return {
          allowed: false,
          reason: 'bulk_consent_insufficient_for_promotional',
          customerId: doc.id,
        };
      }
      return { allowed: true, reason: 'consented', customerId: doc.id };
    }
    return { allowed: false, reason: 'no_consent_on_record', customerId: doc.id };
  }

  return { allowed: false, reason: 'no_customer_record' };
}

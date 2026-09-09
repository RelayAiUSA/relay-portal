// relay-pwa/functions/lib/review-invite.mjs
//
// Consumer-granted consent for review requests.
//
// WHY THIS EXISTS
//
// A review request is solicitation: carriers treat it as marketing, and the
// TCPA bar for marketing is express written consent from the CONSUMER. What
// Relay had instead was the contractor's attestation about their customer -
// a defense you argue rather than one you produce.
//
// So the invoice, which the customer already consented to receive, ends with a
// one-line invitation. A "YES" back is the consumer's own recorded act:
// timestamped, in their words, on a carrier record Relay does not control. That
// is the strongest artifact available for this class of message, and it costs
// no extra send because it rides on a message already going out.
//
// The reply arrives from a CONSUMER's number, which belongs to no Relay
// account, so the invite has to be findable by phone number alone - hence a
// top-level collection rather than something under users/{uid}. Admin SDK only;
// no client rule, so firestore.rules' deny-all covers it, which is correct.

import { normalizePhone } from './consent.mjs';

const COLLECTION = 'reviewInvites';

// How long a YES still counts. Long enough that a customer who reads the text
// that evening is fine; short enough that a reply months later, to a message
// nobody remembers, is not treated as consent.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The line appended to the invoice. Three things have to be in it for the
// consent to be worth holding: what they will RECEIVE (a text with a link, not
// "submit a review" - replying does not submit anything and promising that it
// does is how you earn a spam report), that rates may apply, and how to stop.
export const REVIEW_INVITE_LINE =
  "Reply YES and we'll text you a link to review our work. Msg rates may apply. Reply STOP to opt out.";

// Deliberately narrower than the contractor-facing yes/no test. A consumer
// replying "ok" to an invoice is acknowledging the invoice, not consenting to
// marketing, so only an explicit affirmative counts.
const YES = /^(y|yes|yeah|yep|yup|sure)\b/i;
const NO  = /^(n|no|nope|nah)\b/i;

export function isInviteYes(body) { return YES.test(String(body || '').trim()); }
export function isInviteNo(body)  { return NO.test(String(body || '').trim()); }

/** Record that this consumer was invited, so a later YES can be attributed. */
export async function recordInvite(db, phone, { uid, customerName = '', invoiceId = null }) {
  const key = normalizePhone(phone);
  if (!key || !uid) return false;
  try {
    await db.collection(COLLECTION).doc(key).set({
      phoneDigits: key,
      uid,
      customerName,
      invoiceId,
      invitedAt: new Date(),
    });
    return true;
  } catch (err) {
    console.error('[review-invite] record failed:', err.message);
    return false;
  }
}

/** The live invite for this number, or null if there is none or it has expired. */
export async function getInvite(db, phone) {
  const key = normalizePhone(phone);
  if (!key) return null;
  try {
    const snap = await db.collection(COLLECTION).doc(key).get();
    if (!snap.exists) return null;
    const d = snap.data();
    const at = d.invitedAt?.toMillis?.() ?? Date.parse(d.invitedAt || '') ?? 0;
    if (!at || Date.now() - at > INVITE_TTL_MS) return null;
    return { ...d, ref: snap.ref };
  } catch (err) {
    console.error('[review-invite] lookup failed:', err.message);
    return null;
  }
}

/**
 * Write the consumer's answer onto the contractor's customer record, which is
 * what canTextCustomer() reads.
 *
 * A YES sets scope 'all' - the level that satisfies the promotional gate -
 * because unlike a bulk attestation this consent came from the consumer.
 * The exact wording they replied to is stored with it: a consent record that
 * cannot show what was asked is worth very little in a dispute.
 */
export async function applyInviteAnswer(db, invite, phone, agreed) {
  const key = normalizePhone(phone);
  const consent = agreed
    ? {
        smsConsent:              true,
        smsConsentScope:         'all',
        smsConsentMethod:        'customer_sms_reply',
        smsConsentAt:            new Date(),
        smsConsentPrompt:        REVIEW_INVITE_LINE,
        smsConsentSource:        'consumer',
        reviewConsentByCustomer: true,
      }
    : {
        // A NO is not an opt-out of everything - they still get their invoices.
        // It is a refusal of review requests specifically.
        reviewConsentByCustomer: false,
        reviewOptOutAt:          new Date(),
        smsConsentScope:         'transactional',
      };

  try {
    const cxSnap = await db.collection('users').doc(invite.uid).collection('customers').get();
    const hit = cxSnap.docs.find(d => normalizePhone(d.data().phone) === key
                                   || normalizePhone(d.data().secondaryPhone) === key);
    if (hit) {
      await hit.ref.update(consent);
    } else {
      await db.collection('users').doc(invite.uid).collection('customers').add({
        name:      invite.customerName || 'Customer',
        phone,
        createdAt: new Date(),
        ...consent,
      });
    }
    await invite.ref.delete().catch(() => {});
    return true;
  } catch (err) {
    console.error('[review-invite] apply failed:', err.message);
    return false;
  }
}

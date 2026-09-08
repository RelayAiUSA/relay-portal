// relay-pwa/functions/twilio-sms.mjs
// Receives inbound SMS from Twilio, dispatches AI-generated invoice/quote via SMS.
//
// Tier gating:
//   starter   → upgrade prompt only
//   essential → AI parse + dispatch + accounting sync
//   pro       → all essential features + auto-forward to customer + review request SMS
//
// Migrated to Netlify Functions v2 (no Lambda compat layer) to avoid 4KB env var limit.

import Anthropic from '@anthropic-ai/sdk';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { syncInvoiceToAccounting } from './lib/accounting-sync.mjs';
import { alertError } from './lib/alert.mjs';
import { canTextCustomer, normalizePhone } from './lib/consent.mjs';
import { isStopKeyword, isStartKeyword, suppressNumber, unsuppressNumber } from './lib/suppression.mjs';
import { validateTwilioSignature } from './lib/twilio-signature.mjs';
import { guardParsedJob, extractJson } from './lib/parse-guard.mjs';

// ── Firebase Admin init ───────────────────────────────────────────────────────

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

// ── Clients ───────────────────────────────────────────────────────────────────

// Twilio via plain fetch — no SDK. The twilio npm package uses dynamic
// requires that esbuild cannot statically resolve, which crashed this
// function at import time with ERR_MODULE_NOT_FOUND on ValidationToken.
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      // StatusCallback closes the loop. Without it Twilio's 202 was the last
      // thing Relay ever heard about a message: 'reply sent' in the log and
      // silence on the handset looked identical to a bug in this function.
      // sms-status now records the carrier's verdict and its error code.
      body: new URLSearchParams({
        From: TWILIO_FROM,
        To: to,
        Body: body,
        StatusCallback: 'https://portal-relay.com/.netlify/functions/sms-status',
      }).toString(),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data.sid;
}
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+18447291376';

// ── Plan helpers ──────────────────────────────────────────────────────────────

// L5. docLimit() lived only in app.js, so the plan limit existed exactly where
// it could not be enforced: in the browser. Nothing on the SMS path checked or
// incremented the counter, which is why the meter in the portal never moved for
// a contractor who works the way Relay is designed to be worked - by text - and
// why an Essential account could dispatch without bound.
//
// Keep these two numbers identical to docLimit() in app.js.
function docLimitFor(plan) {
  return (plan || '').toLowerCase() === 'pro' ? 500 : 250;
}

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Reserves one document against this month's allowance. Returns
// { allowed, count, limit }. The read and the write are a transaction because
// two texts arriving together would otherwise both read the same count and both
// write count+1, letting a contractor slip past the ceiling.
async function reserveDocSlot(db, uid, plan) {
  const limit = docLimitFor(plan);
  const ref   = db.collection('users').doc(uid).collection('docCounts').doc(monthKey());

  try {
    return await db.runTransaction(async tx => {
      const snap  = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= limit) return { allowed: false, count, limit };
      tx.set(ref, { count: count + 1, updatedAt: new Date() }, { merge: true });
      return { allowed: true, count: count + 1, limit };
    });
  } catch (err) {
    // A counter failure must never swallow a contractor's job. Let the document
    // through and record that the count is now understated.
    console.error('[twilio-sms] doc count transaction failed:', err.message);
    await alertError('twilio-sms:doccount', err, `uid=${uid}`);
    return { allowed: true, count: null, limit };
  }
}

function canSMSDispatch(plan) {
  return ['essential', 'pro'].includes((plan || '').toLowerCase());
}
function canAutoForward(plan) {
  return (plan || '').toLowerCase() === 'pro';
}
// Automated review requests are a RelayPRO feature: listed on the RelayPRO plan
// card only, gated to 'pro' in the frontend's canReviewRequest(), and gated to
// 'pro' in review-request.mjs. Keep all four in agreement.
function canReviewRequest(plan) {
  return (plan || '').toLowerCase() === 'pro';
}
function isActiveStatus(status) {
  return ['active', 'trialing', 'past_due'].includes(status);
}

// ── TwiML reply — Netlify Functions v2 returns a Response ────────────────────

// The contractor's confirmation used to go back as TwiML: Relay handed Twilio
// the text and learned nothing more. When the message never arrived there was
// no message SID, no status and no error anywhere in our logs - the only
// evidence was a contractor saying "I got nothing", which is indistinguishable
// from the function never running at all.
//
// Sending it through the REST API instead means Twilio's answer - a SID, or a
// specific error such as an unverified toll-free number - lands in our log at
// the moment it happens. TwiML remains the fallback so a failure of the API
// call still gets the contractor their confirmation.
async function replyToContractor(to, text) {
  try {
    const sid = await sendSms(to, text);
    console.log(`[twilio-sms] reply sent to ${to} sid=${sid}`);
    // The reply is already on its way; an empty TwiML document prevents Twilio
    // from sending it a second time.
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  } catch (err) {
    console.error(`[twilio-sms] reply to ${to} failed, falling back to TwiML: ${err.message}`);
    await alertError('twilio-sms:reply', err, `to=${to}`);
    return twimlResponse(text);
  }
}

function twimlResponse(msg) {
  const safe = String(msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`,
    { status: 200, headers: { 'Content-Type': 'text/xml' } }
  );
}

// ── Main handler — Netlify Functions v2 ──────────────────────────────────────

// Catch-all. Every handler below had an unguarded prologue - work that ran
// before its own try block, such as getDb() or reading the request - so an
// error there escaped with no alert at all: the function 500'd, nobody was
// told, and the failure was only discoverable by a customer complaining.
//
// This wrapper is the last line of defence. It never swallows the error
// silently: it logs, alerts, and returns a response appropriate to this
// endpoint's protocol.
export default async (req, context) => {
  try {
    return await handleInboundSms(req, context);
  } catch (err) {
    console.error('[twilio-sms] unhandled error:', err);
    // An alert failure must not mask the original error.
    try {
      await alertError('twilio-sms:unhandled', err);
    } catch (alertErr) {
      console.error('[twilio-sms] alert failed:', alertErr?.message);
    }
    return twimlResponse(
      'Relay hit an unexpected error handling that message. Nothing was charged. ' +
      'Please try again, or submit it at portal-relay.com.'
    );
  }
};

async function handleInboundSms(req, context) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const bodyText   = await req.text();
  const params     = new URLSearchParams(bodyText || '');

  // ── Authenticate the request before doing anything with it ────────────────
  // This endpoint is public. Without this check a forged POST naming any
  // contractor's phone number creates a real invoice in their account, spends
  // an Anthropic call, and syncs a fabricated invoice to their accounting
  // software. Validate first, so a forged request costs nothing.
  //
  // Set TWILIO_SIGNATURE_VALIDATION=off in Netlify to bypass this if it ever
  // misfires; that is a deliberate, temporary escape hatch, not a default.
  const sig = validateTwilioSignature(
    req,
    Object.fromEntries(params.entries()),
    process.env.TWILIO_AUTH_TOKEN
  );
  if (!sig.valid) {
    console.warn('[twilio-sms] rejected unsigned/invalid request:', sig.reason);
    return new Response('Forbidden', { status: 403 });
  }

  const fromPhone  = params.get('From') || '';
  const body       = (params.get('Body') || '').trim();

  if (!fromPhone || !body) return twimlResponse('Missing phone or message body.');

  // ── STOP / START, before anything else ────────────────────────────────────
  // Handled ahead of the contractor lookup on purpose: the person opting out is
  // usually a CONSUMER, not one of our accounts, so an opt-out that ran after
  // the lookup would hit "Phone number not registered" and be thrown away - the
  // single worst possible response to someone asking not to be texted.
  //
  // Twilio also intercepts these keywords itself. Recording them here as well
  // means the opt-out lives in Relay's own data, so it survives a change of
  // provider or a second sending number, and it outranks any consent record a
  // contractor holds.
  if (isStopKeyword(body)) {
    await suppressNumber(db, fromPhone, { reason: 'stop_keyword' });
    // Twilio sends its own STOP confirmation; returning empty TwiML avoids a
    // second message to someone who just asked for none.
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }
  if (isStartKeyword(body)) {
    await unsuppressNumber(db, fromPhone);
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }

  // ── Identify the contractor by the number they texted from ────────────────
  // This is the single point of failure for the whole product: if the stored
  // number does not match what Twilio sends, the reply is "not registered" and
  // nothing is created, which reads as a broken product rather than a settings
  // problem.
  //
  // phoneDigits (last 10) is the canonical key precisely because it is immune
  // to formatting: '(616) 248-1977', '616-248-1977' and '+16162481977' all
  // reduce to the same value. The exact-string queries below it are legacy
  // fallbacks for documents written before phoneDigits existed.
  const digits = normalizePhone(fromPhone);
  const snaps = await Promise.all([
    digits
      ? db.collection('users').where('phoneDigits', '==', digits).limit(1).get()
      : Promise.resolve({ empty: true, docs: [] }),
    db.collection('users').where('phoneNumber', '==', fromPhone).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', '+' + fromPhone.replace(/\D/g, '')).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', fromPhone.replace(/\D/g, '')).limit(1).get(),
    // Oldest accounts only ever had `phone`, written raw as the user typed it.
    db.collection('users').where('phone', '==', fromPhone).limit(1).get(),
  ]);
  const match = snaps.find(s => !s.empty);
  if (!match) {
    console.warn(`[twilio-sms] no account for ${fromPhone} (digits=${digits})`);
  }
  if (!match) {
    return twimlResponse('Phone number not registered with Relay. Visit portal-relay.com to set up your account.');
  }

  const userDoc  = match.docs[0];
  const uid      = userDoc.id;
  const profile  = userDoc.data();
  const plan     = (profile.plan || 'starter').toLowerCase();
  const subStatus = profile.subscriptionStatus || 'unpaid';

  // ── Tier gate: Starter ────────────────────────────────────────────────────
  if (!canSMSDispatch(plan)) {
    return twimlResponse('SMS Dispatch requires an Essential or Pro plan. Upgrade at portal-relay.com');
  }

  // ── Subscription active check ─────────────────────────────────────────────
  if (!isActiveStatus(subStatus)) {
    return twimlResponse('Your Relay subscription is inactive. Visit portal-relay.com to reactivate.');
  }

  // ── Monthly document allowance ────────────────────────────────────────────
  // Checked here, before the Anthropic call, so a contractor who is already at
  // their ceiling does not cost an AI request per text. The authoritative
  // reservation happens transactionally at creation time below; this is only
  // the cheap early exit.
  {
    const limit = docLimitFor(plan);
    const snap  = await db.collection('users').doc(uid)
      .collection('docCounts').doc(monthKey()).get();
    const used  = snap.exists ? (snap.data().count || 0) : 0;
    if (used >= limit) {
      return twimlResponse(
        `You've used all ${limit} documents on your plan this month. ` +
        `Upgrade at portal-relay.com to keep dispatching — your allowance resets on the 1st.`
      );
    }
  }

  // ── AI: parse + professionalize raw SMS ──────────────────────────────────
  // ── Is this a reply to our review-consent question? ──────────────────
  // Checked before the AI parse so a bare "yes" is never billed as an AI call
  // or turned into a nonsense invoice. Only a lone yes/no counts; anything
  // longer is treated as a new job, so a real job description is never eaten.
  const pending = profile.pendingReviewConsent;
  const isYes   = /^(y|yes|yep|yeah|yup|ok|okay)$/i.test(body);
  const isNo    = /^(n|no|nope|nah)$/i.test(body);

  if (pending?.phone && (isYes || isNo)) {
    const askedMs = pending.askedAt?.toMillis?.() ?? Date.parse(pending.askedAt || '') ?? 0;
    const fresh   = askedMs && (Date.now() - askedMs) < 24 * 60 * 60 * 1000;

    if (fresh) {
      const key = normalizePhone(pending.phone);
      let ref = null;
      try {
        const cxSnap = await db.collection('users').doc(uid).collection('customers').get();
        const hit = cxSnap.docs.find(d => normalizePhone(d.data().phone) === key);
        if (hit) ref = hit.ref;
      } catch (err) {
        console.error('[twilio-sms] consent-reply lookup failed:', err.message);
      }

      const consentFields = isYes
        ? {
            smsConsent:       true,
            smsConsentMethod: 'sms_confirmed_by_contractor',
            smsConsentScope:  'all',
            smsConsentText:   'Contractor confirmed by SMS that this customer agreed '
                            + 'to receive review request texts from their business.',
            smsConsentAt:     FieldValue.serverTimestamp(),
            smsConsentBy:     fromPhone,
          }
        : {
            smsConsent:       false,
            smsConsentMethod: 'none',
            smsConsentScope:  '',
            smsConsentAt:     FieldValue.serverTimestamp(),
            smsConsentBy:     fromPhone,
          };

      try {
        if (ref) {
          await ref.update(consentFields);
        } else {
          await db.collection('users').doc(uid).collection('customers').add({
            name:      pending.customerName || 'Unknown',
            phone:     pending.phone,
            address:   '',
            source:    'sms',
            createdAt: FieldValue.serverTimestamp(),
            ...consentFields,
          });
        }
        await userDoc.ref.update({ pendingReviewConsent: FieldValue.delete() });
      } catch (err) {
        console.error('[twilio-sms] consent-reply write failed:', err.message);
        return twimlResponse('Could not save that — please set the permission at portal-relay.com.');
      }

      const who = pending.customerName || 'that customer';
      return twimlResponse(
        isYes
          ? `Got it — review requests are on for ${who}. Relay will text them 24 hours after the job.`
          : `Understood — no review texts for ${who}. You can change this any time at portal-relay.com.`
      );
    }

    // Stale question: clear it and fall through to treat this as a new job.
    try { await userDoc.ref.update({ pendingReviewConsent: FieldValue.delete() }); } catch {}
  }

  let parsed;
  try {
    const aiRes = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role:    'user',
        content: `You are a professional field-service document assistant. A technician sent this raw SMS:

"${body}"

Extract job details and return ONLY valid JSON (no markdown, no explanation):
{
  "job_type": "repair|install|inspection|quote|other",
  "customer_name": "",
  "customer_phone": "",
  "customer_email": "",
  "address": "",
  "amount": 0,
  "professional_description": "2-4 sentence professional write-up of the work performed",
  "confidence": 0.0
}
If a field is unknown, use empty string or 0.`,
      }],
    });
    parsed = extractJson(aiRes.content[0].text);
  } catch (err) {
    console.error('[twilio-sms] AI parse error:', err);
    await alertError('twilio-sms:ai-parse', err, `from=${fromPhone}`);
    return twimlResponse('Relay could not process your message. Please try again with more detail.');
  }

  // ── Sanity-check the model's output before it becomes a real document ────
  // Untrusted output: it goes onto an invoice sent under the CONTRACTOR'S name,
  // so a misparse costs them their customer relationship, not ours. Coerce what
  // is usable, discard what is not, and refuse to auto-send anything flagged.
  const guard = guardParsedJob(parsed, body);
  if (guard.fatal) {
    console.error('[twilio-sms] parse rejected:', guard.fatal, guard.flags);
    await alertError('twilio-sms:parse-guard',
      new Error(`rejected: ${guard.fatal}`), `from=${fromPhone} flags=${guard.flags.join(',')}`);
    return twimlResponse(
      'Relay could not read a sensible amount from that. Please resend with the ' +
      'price written plainly, e.g. "$450".'
    );
  }
  const job = guard.clean;
  if (guard.flags.length) {
    console.warn('[twilio-sms] parse flags:', guard.flags.join(','), 'uid=' + uid);
  }

  // ── Save invoice to Firestore ─────────────────────────────────────────────
  const invoiceData = {
    // Two field vocabularies exist for the same collection. The portal writes
    // customer / work / email / phone; this function grew up writing
    // customer_name / professional_description / customer_email /
    // customer_phone. The portal's invoice list reads the FORMER, so every
    // SMS-created invoice rendered as "Unknown" with a blank description.
    //
    // Both shapes are written. The portal names are the ones the UI reads; the
    // underscored names are kept because accounting-sync and review-request
    // already read them. Renaming either side alone would break the other.
    customer:                 job.customer_name,
    work:                     job.professional_description,
    email:                    job.customer_email,
    phone:                    job.customer_phone,

    customer_name:            job.customer_name,
    customer_phone:           job.customer_phone,
    customer_email:           job.customer_email,
    address:                  job.address,
    amount:                   job.amount,
    professional_description: job.professional_description,
    job_type:                 job.job_type,
    rawSms:                   body,
    type:                     job.job_type === 'quote' ? 'quote' : 'invoice',
    // 'needs_review' means the parse was implausible or low-confidence. The
    // document is still saved so nothing is lost, but it is not auto-sent.
    status:                   guard.needsReview ? 'needs_review' : 'pending',
    parseFlags:               guard.flags,
    parseConfidence:          job.confidence,
    source:                   'sms',
    plan,
    reviewRequestSent:        false,
    createdAt:                FieldValue.serverTimestamp(),
    sentAt:                   FieldValue.serverTimestamp(),
  };
  // Reserve the slot transactionally. Two texts arriving at once would
  // otherwise both read the same count and both write count+1.
  const slot = await reserveDocSlot(db, uid, plan);
  if (!slot.allowed) {
    return twimlResponse(
      `You've used all ${slot.limit} documents on your plan this month. ` +
      `Upgrade at portal-relay.com to keep dispatching — your allowance resets on the 1st.`
    );
  }

  const invRef = await db.collection('users').doc(uid).collection('invoices').add(invoiceData);

  // ── Public, printable copy of the document ────────────────────────────────
  // doc.html renders /doc/<id> from the publicDocs collection: the customer-
  // facing Service Document, printable to PDF, used for both invoices and
  // quotes. The portal's job form has always written this; twilio-sms never
  // did, so every texted-in job produced an invoice with no viewable document
  // at all - the Share link led nowhere.
  //
  // Only presentation fields are copied here. This collection is world-readable
  // by design (share links are opened by customers who are not signed in), so
  // nothing sensitive from the parent user document may be included.
  try {
    await db.collection('publicDocs').doc(invRef.id).set({
      uid,                                   // required by the publicDocs rule
      companyName:        profile.companyName        || '',
      businessType:       profile.businessType       || '',
      licenseNumber:      profile.licenseNumber      || '',
      invoicePrefix:      profile.invoicePrefix      || '',
      invoiceFooter:      profile.invoiceFooter      || '',
      paymentMethods:     profile.paymentMethods     || [],
      paymentMethodOther: profile.paymentMethodOther || '',
      paymentUsernames:   profile.paymentUsernames   || {},
      paymentTerms:       profile.paymentTerms       || 'Due on receipt',
      estimateValidity:   profile.estimateValidity   || '',
      taxRate:            profile.taxRate            || 0,
      minCallFee:         profile.minCallFee         || 0,
      customer:  job.customer_name,
      email:     job.customer_email,
      phone:     job.customer_phone,
      address:   job.address,
      work:      job.professional_description,
      amount:    job.amount,
      type:      invoiceData.type,
      status:    invoiceData.status,
      source:    'sms',
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // A missing share document must not fail the dispatch: the invoice itself
    // is already saved and the contractor's reply is more important.
    console.error('[twilio-sms] publicDocs write failed:', err.message);
    await alertError('twilio-sms:publicdoc', err, `invoice=${invRef.id}`);
  }

  // ── Accounting sync (Essential + Pro, invoices only) ─────────────────────
  let syncResult = { synced: false, reason: 'not_connected' };
  if (invoiceData.type !== 'quote') {
    syncResult = await syncInvoiceToAccounting(db, uid, invRef.id, invoiceData, profile);
  }

  // ── Pro: auto-forward doc to customer via SMS ─────────────────────────────
  // Consent gate: never auto-forward to a customer without a consent record.
  let fwdConsent = { allowed: false, reason: 'not_attempted' };
  // A flagged document is never auto-sent: the contractor sees it first.
  if (canAutoForward(plan) && profile.autoForwardToCustomer && job.customer_phone
      && !guard.needsReview) {
    fwdConsent = await canTextCustomer(db, uid, job.customer_phone, 'transactional');
    if (!fwdConsent.allowed) {
      console.log(`[twilio-sms] auto-forward blocked uid=${uid} reason=${fwdConsent.reason}`);
    }
  }
  if (fwdConsent.allowed) {
    const docType = invoiceData.type === 'quote' ? 'Quote' : 'Invoice';
    const fwdMsg  = [
      `Hi ${job.customer_name || 'there'}, your ${docType} from ${profile.companyName || 'your contractor'} is ready:`,
      '',
      job.professional_description,
      '',
      `Amount: $${job.amount || 'TBD'}`,
      '',
      'Questions? Reply to this message.',
    ].join('\n');
    await sendSms(job.customer_phone, fwdMsg)
      .catch(e => console.error('[twilio-sms] Auto-forward failed:', e.message));
  }

  // ── Reply to technician ───────────────────────────────────────────────────
  const description = job.professional_description || '';
  const preview     = description.length > 120 ? description.slice(0, 120) + '...' : description;
  const replyLines  = [
    'Relay dispatched your job.',
    `Type: ${invoiceData.type} | Amount: $${job.amount || 'TBD'}`,
    `"${preview}"`,
  ];

  if (fwdConsent.allowed) {
    replyLines.push('Doc sent to customer via SMS.');
  } else if (canAutoForward(plan) && profile.autoForwardToCustomer && job.customer_phone) {
    const blockMsg = {
      opted_out:            'Not texted — this customer opted out (replied STOP).',
      no_customer_record:   'Not texted — this customer is not in your portal yet. Add them at portal-relay.com and set their text message permission.',
      no_consent_on_record: 'Not texted — text message permission is not set for this customer. Open their page at portal-relay.com and update Text Message Consent.',
    }[fwdConsent.reason] ||
      'Not texted — check this customer\'s text message permission at portal-relay.com.';
    replyLines.push(blockMsg);
  }

  if (invoiceData.type !== 'quote') {
    if (syncResult.synced) {
      const label = syncResult.provider === 'quickbooks' ? 'QuickBooks' : 'Zoho Books';
      replyLines.push(`Synced to ${label} (#${syncResult.externalNumber || syncResult.externalId}).`);
    } else if (syncResult.reason === 'not_connected' || syncResult.reason === 'no_provider') {
      replyLines.push('Connect your accounting software at portal-relay.com to auto-sync invoices.');
    } else {
      replyLines.push('Saved, but accounting sync failed — check portal-relay.com.');
    }
  }

  if (guard.needsReview) {
    replyLines.push('Held for your review before sending — open it at portal-relay.com.');
  }

  // ── RelayPRO: ask about review consent for a customer we cannot text yet ──
  // Only Pro accounts get automated review requests, so only Pro accounts are
  // asked. Review texts need per-customer consent ('promotional' scope), which
  // a bulk import attestation deliberately does not satisfy.
  if (canReviewRequest(plan) && job.customer_phone) {
    const revConsent = await canTextCustomer(db, uid, job.customer_phone, 'promotional');
    if (!revConsent.allowed && revConsent.reason !== 'opted_out') {
      try {
        await userDoc.ref.update({
          pendingReviewConsent: {
            phone:        job.customer_phone,
            customerName: job.customer_name || '',
            invoiceId:    invRef.id,
            askedAt:      new Date(),
          },
        });
        const who = job.customer_name || 'this customer';
        replyLines.push(
          `Has ${who} agreed to receive review request texts from you? Reply YES or NO.`
        );
      } catch (err) {
        console.error('[twilio-sms] could not store pendingReviewConsent:', err.message);
      }
    }
  }

  return replyToContractor(fromPhone, replyLines.join('\n'));
}

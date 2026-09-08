// relay-pwa/functions/review-request.mjs
// Netlify scheduled function — runs every hour, sends review SMS 24 hrs after job
// submission. RelayPRO accounts only.
//
// Schedule (see netlify.toml):
//   [functions.review-request]
//   schedule = "0 * * * *"
//
// Required env vars (Netlify dashboard > Site > Environment variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_PHONE_NUMBER
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY      (full private key string)
//
// Migrated to Netlify Functions v2 (no Lambda compat layer) to avoid 4KB env var limit.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { alertError } from './lib/alert.mjs';
import { canTextCustomer } from './lib/consent.mjs';

// Firebase Admin — lazy singleton with duplicate-init guard
let _db;
function getDb() {
  if (!_db) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    }
    _db = getFirestore();
  }
  return _db;
}

// Twilio SMS — plain fetch, no SDK needed
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) throw new Error('Twilio env vars not configured');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data.sid;
}

// TCPA compliance — only send 8am-8pm local time
function isWithinSendWindow(utcOffset = -5) {
  const utcHour   = new Date().getUTCHours();
  const localHour = ((utcHour + utcOffset) % 24 + 24) % 24;
  return localHour >= 8 && localHour < 20;
}

// Build the review SMS body
function buildReviewSms(customerName, companyName, reviewLink) {
  const first = (customerName || '').split(' ')[0] || 'there';
  return (
    `Hey ${first} — ${companyName} here. ` +
    `If you were happy with the work, a quick Google review means a lot to a small business: ${reviewLink} ` +
    `Reply STOP to opt out.`
  );
}

// Normalize a Firestore timestamp or string to ms
function toMs(val) {
  if (!val) return null;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (val._seconds) return val._seconds * 1000;
  return new Date(val).getTime() || null;
}

// Scan one subcollection for jobs that need a review request
async function processCollection(db, uid, collName, userData, results) {
  const now         = Date.now();
  const windowStart = now - 25 * 60 * 60 * 1000;
  const windowEnd   = now - 23 * 60 * 60 * 1000;
  const companyName = userData.companyName || userData.businessName || 'Your service provider';
  // The profile form writes 'reviewUrl'. This previously read 'googleReviewLink',
  // a field nothing has ever written, so every contractor's own link was ignored
  // and every review request fell through to the single global
  // GOOGLE_REVIEW_LINK env var — sending every contractor's customers to the
  // SAME business's review page. The env var fallback is removed deliberately:
  // skipping a review request is always better than pointing a customer at
  // someone else's Google listing. 'googleReviewLink' is still read second in
  // case any legacy document carries it.
  const reviewLink  = userData.reviewUrl || userData.googleReviewLink || '';
  const utcOffset   = userData.utcOffset !== undefined ? Number(userData.utcOffset) : -5;

  if (!isWithinSendWindow(utcOffset)) {
    results.skipped.push({ uid, collection: collName, reason: 'outside 8am-8pm send window' });
    return;
  }

  let snap;
  try {
    snap = await db.collection('users').doc(uid).collection(collName)
      .where('reviewRequestSent', '==', false).get();
  } catch (err) { return; }

  for (const doc of snap.docs) {
    const d      = doc.data();
    const sentMs = toMs(d.sentAt) || toMs(d.createdAt) || toMs(d.submittedAt);
    if (!sentMs || sentMs < windowStart || sentMs > windowEnd) continue;

    const phone    = d.customerPhone || d.phone;
    const customer = d.customerName  || d.customer || '';
    if (!phone)       { results.skipped.push({ id: doc.id, collection: collName, reason: 'no phone' }); continue; }
    if (!reviewLink)  { results.skipped.push({ id: doc.id, collection: collName, reason: 'no review link' }); continue; }

    // Consent gate: a review request is a Relay-initiated message to someone
    // else's customer. Without a consent record on file, it is not sent.
    const consent = await canTextCustomer(db, uid, phone, 'promotional');
    if (!consent.allowed) {
      results.skipped.push({ id: doc.id, collection: collName, reason: `consent: ${consent.reason}` });
      continue;
    }

    try {
      const twilioSid = await sendSms(phone, buildReviewSms(customer, companyName, reviewLink));
      await db.collection('users').doc(uid).collection(collName).doc(doc.id).update({
        reviewRequestSent: true, reviewRequestSentAt: new Date(), reviewRequestSid: twilioSid,
      });
      results.sent.push({ id: doc.id, collection: collName, last4: phone.slice(-4) });
    } catch (err) {
      results.errors.push({ id: doc.id, collection: collName, error: err.message });
    }
  }
}

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
    return await handleReviewRequest(req, context);
  } catch (err) {
    console.error('[review-request] unhandled error:', err);
    // An alert failure must not mask the original error.
    try {
      await alertError('review-request:unhandled', err);
    } catch (alertErr) {
      console.error('[review-request] alert failed:', alertErr?.message);
    }
    return new Response('Internal error', { status: 500 });
  }
};

async function handleReviewRequest(req, context) {
  const db      = getDb();
  const results = { sent: [], skipped: [], errors: [] };
  try {
    const usersSnap = await db.collection('users').get();
    for (const userDoc of usersSnap.docs) {
      const uid      = userDoc.id;
      const userData = userDoc.data();
      // RelayPRO only. Automated review requests are listed on the RelayPRO
      // plan card and nowhere else, and the frontend's canReviewRequest() has
      // always been Pro-only — this gate was letting Essential+ accounts run a
      // feature they do not pay for.
      //
      // Normalise first: Firestore has held both 'Starter' and 'starter', and
      // without toLowerCase() a capitalised value slips past any plan check.
      const plan = (userData.plan || 'starter').toLowerCase();
      if (plan !== 'pro') continue;
      for (const coll of ['jobs', 'invoices', 'dispatch']) {
        await processCollection(db, uid, coll, userData, results);
      }
    }
    console.log('[review-request] complete:', { sent: results.sent.length, skipped: results.skipped.length, errors: results.errors.length });
    return Response.json(results);
  } catch (err) {
    console.error('[review-request] fatal:', err);
    await alertError('review-request', err);
    return new Response(err.message, { status: 500 });
  }
}

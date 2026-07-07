// relay-pwa/functions/review-request.js
// Netlify scheduled function — runs every hour, sends review SMS 24 hrs after job submission
//
// Schedule (add to netlify.toml):
//   [functions.review-request]
//   schedule = "0 * * * *"
//
// Required env vars (Netlify dashboard > Site > Environment variables):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY      (full private key string)
//   GOOGLE_REVIEW_LINK        (fallback if not set per-user in Firestore)

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

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
  const from  = process.env.TWILIO_FROM_NUMBER;
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
  const reviewLink  = userData.googleReviewLink || process.env.GOOGLE_REVIEW_LINK || '';
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

exports.handler = async function () {
  const db      = getDb();
  const results = { sent: [], skipped: [], errors: [] };
  try {
    const usersSnap = await db.collection('users').get();
    for (const userDoc of usersSnap.docs) {
      const uid      = userDoc.id;
      const userData = userDoc.data();
      const plan     = userData.plan || 'starter';
      if (plan === 'starter') continue;  // Review requests: Essential+ and RelayPRO only
      for (const coll of ['jobs', 'invoices', 'dispatch']) {
        await processCollection(db, uid, coll, userData, results);
      }
    }
    console.log('[review-request] complete:', { sent: results.sent.length, skipped: results.skipped.length, errors: results.errors.length });
    return { statusCode: 200, body: JSON.stringify(results) };
  } catch (err) {
    console.error('[review-request] fatal:', err);
    return { statusCode: 500, body: err.message };
  }
};

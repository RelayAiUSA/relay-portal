// relay-pwa/functions/review-request.js
// Netlify scheduled function — runs every hour
// Sends Google review SMS 24hrs after a paid invoice
// Schedule: add to netlify.toml:
//   [functions.review-request]
//   schedule = "0 * * * *"

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

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

async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
  return data.sid;
}

exports.handler = async function () {
  const db         = getDb();
  const reviewLink = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_PLACE_ID/review';
  const now        = Date.now();
  const winStart   = now - 25 * 60 * 60 * 1000;
  const winEnd     = now - 23 * 60 * 60 * 1000;
  const sent = [], skipped = [], errors = [];

  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const invSnap = await db
        .collection('users').doc(uid)
        .collection('invoices')
        .where('status', '==', 'paid')
        .where('reviewRequestSent', '==', false)
        .get();

      for (const invDoc of invSnap.docs) {
        const inv    = invDoc.data();
        const paidAt = inv.paidAt?.toMillis ? inv.paidAt.toMillis()
                     : inv.paidAt           ? new Date(inv.paidAt).getTime()
                     : null;

        if (!paidAt || paidAt < winStart || paidAt > winEnd) continue;

        const phone    = inv.customerPhone || inv.phone;
        const customer = inv.customer || 'there';
        const company  = userDoc.data()?.companyName || 'your service provider';

        if (!phone) { skipped.push({ inv: invDoc.id, reason: 'no phone' }); continue; }

        const msg =
          `Hi ${customer}! Thanks for choosing ${company}. ` +
          `If everything went well, we would really appreciate a quick Google review — it means everything to a small business. ` +
          `Takes 30 seconds: ${reviewLink}\n\nReply STOP to opt out.`;

        try {
          const twilioSid = await sendSms(phone, msg);
          await db.collection('users').doc(uid)
            .collection('invoices').doc(invDoc.id)
            .update({
              reviewRequestSent:   true,
              reviewRequestSentAt: new Date(),
              reviewRequestSid:    twilioSid,
            });
          sent.push({ inv: invDoc.id, to: phone.slice(-4) });
        } catch (err) {
          errors.push({ inv: invDoc.id, error: err.message });
        }
      }
    }

    console.log('review-request:', { sent: sent.length, skipped: skipped.length, errors: errors.length });
    return { statusCode: 200, body: JSON.stringify({ sent, skipped, errors }) };
  } catch (err) {
    console.error('review-request fatal:', err);
    return { statusCode: 500, body: err.message };
  }
};

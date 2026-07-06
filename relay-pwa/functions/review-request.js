// relay-pwa/functions/review-request.js
// Netlify scheduled function — runs every hour, sends review SMS 24hrs after invoice is sent
// Schedule: set in netlify.toml as [functions.review-request] schedule = "0 * * * *"
//
// Required env vars (set in Netlify dashboard):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER  (+18447291376)
//   FIREBASE_PROJECT_ID (relay-portal-68417)
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//   GOOGLE_REVIEW_LINK  (your Google Business review URL)

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

// ── Firebase Admin init (lazy singleton) ─────────────────────────────────────
let _db;
function getDb() {
  if (!_db) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
    _db = getFirestore();
  }
  return _db;
}

// ── Twilio SMS send ───────────────────────────────────────────────────────────
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;

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
  if (!res.ok) throw new Error(`Twilio error: ${data.message}`);
  return data.sid;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function () {
  const db          = getDb();
  const reviewLink  = process.env.GOOGLE_REVIEW_LINK || 'https://g.page/r/YOUR_PLACE_ID/review';
  const now         = Date.now();
  const windowStart = now - 25 * 60 * 60 * 1000; // 25 hrs ago
  const windowEnd   = now - 23 * 60 * 60 * 1000; // 23 hrs ago

  const sent = [], skipped = [], errors = [];

  try {
    const usersSnap = await db.collection('users').get();

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;

      // Find invoices sent 23-25 hrs ago that haven't had a review request yet
      const invSnap = await db
        .collection('users').doc(uid)
        .collection('invoices')
        .where('reviewRequestSent', '==', false)
        .get();

      for (const invDoc of invSnap.docs) {
        const inv = invDoc.data();

        // Use sentAt (when invoice was sent to customer)
        const sentAt = inv.sentAt?.toMillis ? inv.sentAt.toMillis()
                     : inv.sentAt           ? new Date(inv.sentAt).getTime()
                     : null;

        if (!sentAt || sentAt < windowStart || sentAt > windowEnd) continue;

        const phone    = inv.customerPhone || inv.phone;
        const customer = inv.customer || 'there';
        const company  = userDoc.data()?.companyName || 'your service provider';

        if (!phone) {
          skipped.push({ inv: invDoc.id, reason: 'no phone' });
          continue;
        }

        const msg =
          `Hi ${customer}! Thanks for choosing ${company}. ` +
          `If everything went well, we'd really appreciate a quick Google review — it means everything to a small business. ` +
          `Takes 30 seconds: ${reviewLink}\n\nReply STOP to opt out.`;

        try {
          const twilioSid = await sendSms(phone, msg);

          await db
            .collection('users').doc(uid)
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
      // ── Also check dispatch collection ─────────────────────────────────────
      const dispSnap = await db
        .collection('users').doc(uid)
        .collection('dispatch')
        .where('reviewRequestSent', '==', false)
        .get();

      for (const dispDoc of dispSnap.docs) {
        const disp    = dispDoc.data();
        const sentAt  = disp.sentAt?.toMillis ? disp.sentAt.toMillis()
                      : disp.sentAt           ? new Date(disp.sentAt).getTime()
                      : null;

        if (!sentAt || sentAt < windowStart || sentAt > windowEnd) continue;

        const phone    = disp.phone;
        const customer = disp.customer || 'there';
        const company  = userDoc.data()?.companyName || 'your service provider';

        if (!phone) {
          skipped.push({ doc: dispDoc.id, reason: 'no phone' });
          continue;
        }

        const msg =
          `Hi ${customer}! Thanks for choosing ${company}. ` +
          `If everything went well, we'd really appreciate a quick Google review — it means everything to a small business. ` +
          `Takes 30 seconds: ${reviewLink}\n\nReply STOP to opt out.`;

        try {
          const twilioSid = await sendSms(phone, msg);

          await db
            .collection('users').doc(uid)
            .collection('dispatch').doc(dispDoc.id)
            .update({
              reviewRequestSent:   true,
              reviewRequestSentAt: new Date(),
              reviewRequestSid:    twilioSid,
            });

          sent.push({ doc: dispDoc.id, to: phone.slice(-4) });
        } catch (err) {
          errors.push({ doc: dispDoc.id, error: err.message });
        }
      }
    }

    console.log('review-request run:', { sent: sent.length, skipped: skipped.length, errors: errors.length });
    return { statusCode: 200, body: JSON.stringify({ sent, skipped, errors }) };

  } catch (err) {
    console.error('review-request fatal:', err);
    return { statusCode: 500, body: err.message };
  }
};

// netlify/functions/review-request-sweep.js
// Scheduled function (see netlify.toml) -- runs every 30 minutes. Finds
// review_requests that are due (scheduledFor has passed) and haven't been
// sent yet, and texts the customer the tradesperson's saved Google (or other
// social) review link. This is what actually processes the queue that
// twilio-sms.js writes to -- without this, queued review requests just sat
// in Firestore forever and nothing ever sent.

const twilio = require('twilio');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+18447291376';

// Process at most this many per run so one sweep can't run away on a backlog.
const BATCH_LIMIT = 50;

function buildReviewMessage({ customerName, companyName, reviewUrl }) {
  return `Hi ${customerName}, thanks for choosing ${companyName}! If you have a moment, ` +
    `we'd really appreciate a quick review: ${reviewUrl}`;
}

exports.handler = async function () {
  const now = admin.firestore.Timestamp.now();

  const dueSnap = await db.collection('review_requests')
    .where('status', '==', 'pending')
    .where('scheduledFor', '<=', now)
    .limit(BATCH_LIMIT)
    .get();

  const results = { total: dueSnap.size, sent: 0, skipped: 0, failed: 0 };

  for (const doc of dueSnap.docs) {
    const req = doc.data();

    // A customer phone or review link can be missing if the tradesperson's
    // profile changed between the SMS being sent and the request coming due
    // -- skip rather than fail loudly, and mark it so it doesn't retry forever.
    if (!req.customerPhone || !req.reviewUrl) {
      await doc.ref.update({
        status: 'skipped',
        skippedReason: !req.customerPhone ? 'missing_customer_phone' : 'missing_review_url',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      results.skipped++;
      continue;
    }

    try {
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: req.customerPhone,
        body: buildReviewMessage({
          customerName: req.customerName || 'there',
          companyName: req.companyName || 'your contractor',
          reviewUrl: req.reviewUrl,
        }),
      });

      await doc.ref.update({
        status: 'sent',
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      results.sent++;
    } catch (err) {
      console.error(`Review request send failed for ${doc.id}:`, err);
      await doc.ref.update({
        status: 'failed',
        error: err.message,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      results.failed++;
    }
  }

  console.log('Review request sweep complete:', results);
  return { statusCode: 200, body: JSON.stringify(results) };
};

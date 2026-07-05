// netlify/functions/stripe-webhook.js
// Handles Stripe subscription events â updates Firestore user subscriptionStatus

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin  = require('firebase-admin');

// ââ Firebase Admin init (once) ââââââââââââââââââââââââââââââââââââââââââââââââ
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ââ Handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Verify Stripe signature
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const { type, data } = stripeEvent;
  const obj = data.object;

  console.log(`Stripe event: ${type}`);

  try {
    switch (type) {
      // Subscription created or updated â sync status directly
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        // Stripe status: active | trialing | past_due | canceled | unpaid | incomplete
        const status = obj.status;
        await updateUser(obj.customer, { subscriptionStatus: status });
        break;
      }

      // Subscription deleted â mark canceled
      case 'customer.subscription.deleted': {
        await updateUser(obj.customer, { subscriptionStatus: 'canceled' });
        break;
      }

      // Successful invoice payment â ensure status is active
      case 'invoice.payment_succeeded': {
        if (obj.subscription) {
          await updateUser(obj.customer, { subscriptionStatus: 'active' });
        }
        break;
      }

      // Failed invoice payment â log; subscription.updated will set past_due/unpaid
      case 'invoice.payment_failed': {
        console.log(`Payment failed for customer: ${obj.customer}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${type}`);
    }
  } catch (err) {
    console.error(`Error handling ${type}:`, err);
    return { statusCode: 500, body: 'Internal server error' };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ââ Helper: find Firestore user by Stripe customer ID, update fields ââââââââââ
async function updateUser(customerId, updates) {
  // 1. Fast path: look up cached stripeCustomerId in Firestore
  const snap = await db.collection('users')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();

  if (!snap.empty) {
    await snap.docs[0].ref.update(updates);
    console.log(`Updated user ${snap.docs[0].id}:`, updates);
    return;
  }

  // 2. Slow path: retrieve customer email from Stripe, then look up Firebase UID
  const customer = await stripe.customers.retrieve(customerId);
  const email = customer.email;
  if (!email) {
    console.error(`No email on Stripe customer ${customerId} â cannot update Firestore`);
    return;
  }

  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    const userRef = db.collection('users').doc(userRecord.uid);
    await userRef.set(
      { ...updates, stripeCustomerId: customerId },
      { merge: true }
    );
    console.log(`Updated user ${userRecord.uid} (by email ${email}):`, updates);
  } catch (err) {
    console.error(`Could not find Firebase user for email ${email}:`, err.message);
  }
}

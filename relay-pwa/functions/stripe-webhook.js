// relay-pwa/functions/stripe-webhook.js
// Netlify function — receives Stripe subscription events and syncs plan to Firestore
//
// Required env vars:
//   STRIPE_SECRET_KEY        live secret key ([live key])
//   STRIPE_WEBHOOK_SECRET    from Stripe Dashboard > Webhooks > signing secret
//   STRIPE_PRICE_STARTER     Stripe price ID for $19 plan
//   STRIPE_PRICE_ESSENTIAL   Stripe price ID for $49 plan
//   STRIPE_PRICE_PRO         Stripe price ID for $99 plan
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore }                 = require('firebase-admin/firestore');

// Firebase singleton
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

// Price ID to plan name
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_PRO)       return "pro";
  if (priceId === process.env.STRIPE_PRICE_ESSENTIAL) return "essential";
  if (priceId === process.env.STRIPE_PRICE_STARTER)   return "starter";
  return "starter"; // fallback
}

// Find Firestore user by stripeCustomerId or email
async function findUserDoc(db, stripeCustomerId) {
  let snap = await db.collection('users')
    .where('stripeCustomerId', '==', stripeCustomerId)
    .limit(1).get();
  if (!snap.empty) return snap.docs[0];

  // Fallback: look up email from Stripe then match in Firestore
  const customer = await stripe.customers.retrieve(stripeCustomerId);
  if (!customer || customer.deleted || !customer.email) return null;

  snap = await db.collection('users')
    .where('email', '==', customer.email)
    .limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  const db  = getDb();
  const obj = stripeEvent.data.object;

  try {
    if (stripeEvent.type === 'customer.subscription.created' ||
        stripeEvent.type === 'customer.subscription.updated') {
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan    = planFromPriceId(priceId);
      const status  = obj.status; // active | trialing | past_due | canceled
      const trialEnd = obj.trial_end ? new Date(obj.trial_end * 1000) : null;

      const userDoc = await findUserDoc(db, obj.customer);
      if (!userDoc) { console.warn('No user for customer:', obj.customer); }
      else {
        await userDoc.ref.update({
          plan,
          subscriptionStatus: status,
          stripeCustomerId:   obj.customer,
          stripeSubscriptionId: obj.id,
          trialEnd,
          planUpdatedAt: new Date(),
        });
        console.log('Plan updated:', userDoc.id, '->', plan, status);
      }
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const userDoc = await findUserDoc(db, obj.customer);
      if (userDoc) {
        await userDoc.ref.update({
          plan:               'starter',
          subscriptionStatus: 'canceled',
          trialEnd:           null,
          planUpdatedAt:      new Date(),
        });
        console.log('Plan canceled, downgraded to starter:', userDoc.id);
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('stripe-webhook error:', err);
    return { statusCode: 500, body: err.message };
  }
};

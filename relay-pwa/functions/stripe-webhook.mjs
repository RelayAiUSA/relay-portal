// relay-pwa/functions/stripe-webhook.mjs
// Netlify function — receives Stripe events and syncs subscription plan to Firestore
//
// Stripe webhook URL to register in Stripe Dashboard > Developers > Webhooks:
//   https://portal-relay.com/.netlify/functions/stripe-webhook
//
// Events to enable:
//   checkout.session.completed
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//   invoice.payment_failed
//
// Required env vars (Netlify dashboard > Site > Environment variables):
//   STRIPE_SECRET_KEY         (Stripe dashboard > API keys)
//   STRIPE_WEBHOOK_SECRET     (Stripe dashboard > Webhooks > signing secret)
//   STRIPE_PRICE_STARTER      (price_... ID for the $19/mo plan)
//   STRIPE_PRICE_ESSENTIAL    (price_... ID for the $49/mo plan)
//   STRIPE_PRICE_PRO          (price_... ID for the $99/mo plan)
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//
// Migrated from Lambda compatibility mode to the modern Netlify Functions runtime
// using @netlify/aws-lambda-compat — handler logic (including signature
// verification against the raw event.body) is unchanged.

import { withLambda } from "@netlify/aws-lambda-compat";
import StripeLib from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const stripe = StripeLib(process.env.STRIPE_SECRET_KEY);

// Firebase Admin — lazy singleton
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

// Map Stripe price ID to internal plan name
function planFromPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_PRO)       return 'pro';
  if (priceId === process.env.STRIPE_PRICE_ESSENTIAL) return 'essential';
  if (priceId === process.env.STRIPE_PRICE_STARTER)   return 'starter';
  console.warn('[stripe-webhook] Unknown price ID:', priceId, '— defaulting to starter');
  return 'starter';
}

// Find Firestore user doc by Stripe customer ID, with email fallback
async function findUserDoc(db, stripeCustomerId) {
  let snap = await db.collection('users')
    .where('stripeCustomerId', '==', stripeCustomerId).limit(1).get();
  if (!snap.empty) return snap.docs[0];
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (!customer || customer.deleted || !customer.email) return null;
    snap = await db.collection('users').where('email', '==', customer.email).limit(1).get();
    return snap.empty ? null : snap.docs[0];
  } catch (err) {
    console.error('[stripe-webhook] Customer lookup failed:', err.message);
    return null;
  }
}

// checkout.session.completed — first event when user pays via Stripe Checkout link
// Critical: this is how stripeCustomerId gets written to Firestore on first signup
async function handleCheckoutCompleted(db, session) {
  const customerId     = session.customer;
  const subscriptionId = session.subscription;
  const email          = session.customer_details?.email || session.customer_email;
  if (!email) { console.warn('[stripe-webhook] No email on checkout session:', session.id); return; }

  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) { console.warn('[stripe-webhook] No Firestore user for email:', email); return; }
  const userDoc = snap.docs[0];

  let plan = 'starter', status = 'active', trialEnd = null;
  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      plan      = planFromPriceId(sub.items.data[0]?.price?.id);
      status    = sub.status;
      trialEnd  = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
    } catch (err) { console.error('[stripe-webhook] Sub retrieve failed:', err.message); }
  }

  await userDoc.ref.update({
    plan, subscriptionStatus: status,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId || null,
    trialEnd, planActivatedAt: new Date(), planUpdatedAt: new Date(),
  });
  console.log('[stripe-webhook] Checkout complete:', userDoc.id, '->', plan, status);
}

// customer.subscription.created / updated
async function handleSubscriptionChange(db, sub) {
  const plan     = planFromPriceId(sub.items?.data?.[0]?.price?.id);
  const status   = sub.status;
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
  const userDoc  = await findUserDoc(db, sub.customer);
  if (!userDoc) { console.warn('[stripe-webhook] No user for customer:', sub.customer); return; }
  await userDoc.ref.update({
    plan, subscriptionStatus: status,
    stripeCustomerId: sub.customer, stripeSubscriptionId: sub.id,
    trialEnd, planUpdatedAt: new Date(),
  });
  console.log('[stripe-webhook] Subscription updated:', userDoc.id, '->', plan, status);
}

// customer.subscription.deleted
async function handleSubscriptionDeleted(db, sub) {
  const userDoc = await findUserDoc(db, sub.customer);
  if (!userDoc) return;
  await userDoc.ref.update({
    plan: 'starter', subscriptionStatus: 'canceled',
    stripeSubscriptionId: null, trialEnd: null, planUpdatedAt: new Date(),
  });
  console.log('[stripe-webhook] Canceled — downgraded to starter:', userDoc.id);
}

// invoice.payment_failed — flag account so app can show payment warning banner
async function handlePaymentFailed(db, invoice) {
  const userDoc = await findUserDoc(db, invoice.customer);
  if (!userDoc) return;
  await userDoc.ref.update({ subscriptionStatus: 'past_due', planUpdatedAt: new Date() });
  console.log('[stripe-webhook] Payment failed — marked past_due:', userDoc.id);
}

// Main handler
export default withLambda(async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      event.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] Signature failed:', err.message);
    return { statusCode: 400, body: 'Invalid signature: ' + err.message };
  }

  const db  = getDb();
  const obj = stripeEvent.data.object;

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':      await handleCheckoutCompleted(db, obj);     break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':   await handleSubscriptionChange(db, obj);    break;
      case 'customer.subscription.deleted':   await handleSubscriptionDeleted(db, obj);   break;
      case 'invoice.payment_failed':          await handlePaymentFailed(db, obj);         break;
      default: console.log('[stripe-webhook] Unhandled event:', stripeEvent.type);
    }
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err);
    return { statusCode: 500, body: err.message };
  }
});

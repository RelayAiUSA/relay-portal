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
//   STRIPE_PRICE_ESSENTIAL    (price_... ID for the $49/mo plan — entry tier)
//   STRIPE_PRICE_PRO          (price_... ID for the $99/mo plan)
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//
// Migrated to Netlify Functions v2 (no Lambda compat layer) to avoid 4KB env var limit.

import StripeLib from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { alertError } from './lib/alert.mjs';

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

// Map Stripe price ID to internal plan name.
// Env vars win; the hardcoded live IDs are a fallback so a missing/typo'd env
// var cannot silently mis-tier a paying customer. Price IDs are not secrets.
const PRICE_MAP = {
  // RelayPRO — $99/mo
  [process.env.STRIPE_PRICE_PRO       || '\0']: 'pro',
  'price_1TpxTORB4QYF5HZ4oIJxr8jN': 'pro',
  // Essential+ — $49/mo (current) and $59/mo (legacy, still active in Stripe)
  [process.env.STRIPE_PRICE_ESSENTIAL || '\0']: 'essential',
  'price_1TqIQXRB4QYF5HZ4Ag5ueyuO': 'essential',
  'price_1Tq3G8RB4QYF5HZ4dIuNmu6Y': 'essential',
  // Starter — $19/mo. Previously unmapped, so Starter subscribers fell through
  // to the 'essential' default and received features they had not paid for.
  [process.env.STRIPE_PRICE_STARTER  || '\0']: 'starter',
  'price_1Tq3FgRB4QYF5HZ4aqBqpC1A': 'starter',
};

function planFromPriceId(priceId) {
  const plan = PRICE_MAP[priceId];
  if (plan) return plan;
  // Least privilege: an unrecognised price must never grant paid features.
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
    plan: 'unpaid', subscriptionStatus: 'canceled',
    stripeSubscriptionId: null, trialEnd: null, planUpdatedAt: new Date(),
  });
  console.log('[stripe-webhook] Canceled — downgraded to unpaid:', userDoc.id);
}

// invoice.payment_failed — flag account so app can show payment warning banner
async function handlePaymentFailed(db, invoice) {
  const userDoc = await findUserDoc(db, invoice.customer);
  if (!userDoc) return;
  await userDoc.ref.update({ subscriptionStatus: 'past_due', planUpdatedAt: new Date() });
  console.log('[stripe-webhook] Payment failed — marked past_due:', userDoc.id);
}

// Main handler — Netlify Functions v2
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await req.text();
  const sig  = req.headers.get('stripe-signature');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] Signature failed:', err.message);
    return new Response('Invalid signature: ' + err.message, { status: 400 });
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
    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err);
    await alertError('stripe-webhook', err, `event=${stripeEvent?.type}`);
    return new Response(err.message, { status: 500 });
  }
};

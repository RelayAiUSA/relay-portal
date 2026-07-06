// netlify/functions/stripe-webhook.js
// Handles Stripe subscription events — updates Firestore user subscriptionStatus + plan

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin  = require('firebase-admin');

// ── Firebase Admin init (once) ──────────────────────────────────────────────
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

// ── Price ID → plan name map ────────────────────────────────────────────────
const PRICE_TO_PLAN = {
  'price_1Tq3FgRB4QYF5HZ4aqBqpC1A': 'Starter',
  'price_1Tq3G8RB4QYF5HZ4dIuNmu6Y': 'Essential',
  'price_1TpxTORB4QYF5HZ4oIJxr8jN': 'Essential+',
};



const ADMIN_EMAIL = 'pryorpropertysolutions269@gmail.com';function planFromSubscription(sub) {
  const priceId = sub?.items?.data?.[0]?.price?.id || '';
  return PRICE_TO_PLAN[priceId] || 'Starter';
}

// ── User lookup ─────────────────────────────────────────────────────────────
async function findUserDoc(customerId, email) {
  // Fast path: match on stripeCustomerId field
  const snap = await db.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
  if (!snap.empty) return snap.docs[0].ref;

  // Slow path: lookup by email via Firebase Auth
  if (email) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      return db.collection('users').doc(user.uid);
    } catch (_) {}
  }
  return null;
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];

  // Try both webhook secrets (snapshot + thin payload)
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_WEBHOOK_SECRET_THIN,
  ].filter(Boolean);

  let stripeEvent, lastErr;
  for (const secret of secrets) {
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!stripeEvent) {
    console.error('Webhook signature failed:', lastErr?.message);
    return { statusCode: 400, body: 'Webhook signature verification failed' };
  }

  const sub = stripeEvent.data.object;
  const customerId = sub.customer;
  const email      = sub.customer_email || sub.metadata?.email || null;
  const type       = stripeEvent.type;

  // ── Status map ─────────────────────────────────────────────────────────────
  const STATUS_MAP = {
    'customer.subscription.created':   sub.status,
    'customer.subscription.updated':   sub.status,
    'customer.subscription.deleted':   'canceled',
    'invoice.payment_succeeded':       'active',
    'invoice.payment_failed':          'past_due',
  };

  if (!STATUS_MAP.hasOwnProperty(type)) {
    return { statusCode: 200, body: JSON.stringify({ received: true, skipped: true }) };
  }

  const newStatus = STATUS_MAP[type];

  // Admin account is never modified by webhooks
  if (email === ADMIN_EMAIL) {
    console.log('Skipping webhook update for admin account');
    return { statusCode: 200, body: JSON.stringify({ received: true, adminSkipped: true }) };
  }

  try {
    const userRef = await findUserDoc(customerId, email);
    if (!userRef) {
      console.warn('No user found for customer:', customerId);
      return { statusCode: 200, body: JSON.stringify({ received: true, userNotFound: true }) };
    }

    const updates = {
      subscriptionStatus: newStatus,
      stripeCustomerId:   customerId,
      updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
    };

    // Set plan name when subscription is created or updated
    if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
      updates.plan = planFromSubscription(sub);
    }
    // On payment success from invoice, re-derive plan from latest sub items if available
    if (type === 'invoice.payment_succeeded' && sub.lines?.data?.[0]?.price?.id) {
      const priceId = sub.lines.data[0].price.id;
      if (PRICE_TO_PLAN[priceId]) updates.plan = PRICE_TO_PLAN[priceId];
    }

    await userRef.update(updates);
    console.log('Updated user', userRef.id, '→', newStatus, updates.plan || '(plan unchanged)');
    return { statusCode: 200, body: JSON.stringify({ received: true, status: newStatus }) };
  } catch (err) {
    console.error('Firestore update error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

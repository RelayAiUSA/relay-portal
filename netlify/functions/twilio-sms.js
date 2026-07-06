// netlify/functions/twilio-sms.js
// Receives inbound SMS from Twilio, dispatches AI-generated invoice/quote
// Tier gating: Starter → upgrade prompt | Essential → AI dispatch | Essential+ → AI + auto-forward + review SMS

const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const admin     = require('firebase-admin');

// ── Firebase Admin init ──────────────────────────────────────────────────────
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

// ── Clients ──────────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+18447291376';

// ── Plan helpers ─────────────────────────────────────────────────────────────
function canSMSDispatch(plan) {
  return ['essential', 'essential+'].includes((plan || '').toLowerCase());
}
function canAutoForward(plan) {
  return (plan || '').toLowerCase() === 'essential+';
}
function isActiveStatus(status) {
  return ['active', 'trialing', 'past_due'].includes(status);
}

// ── TwiML reply ──────────────────────────────────────────────────────────────
function twiml(msg) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const params = new URLSearchParams(event.body || '');
  const fromPhone = params.get('From') || '';
  const body      = (params.get('Body') || '').trim();

  if (!fromPhone || !body) return twiml('Missing phone or message body.');

  // ── Look up Relay user by phoneNumber field ────────────────────────────────
  const normalised = fromPhone.replace(/\D/g, '');
  const snaps = await Promise.all([
    db.collection('users').where('phoneNumber', '==', fromPhone).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', '+' + normalised).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', normalised).limit(1).get(),
  ]);
  const match = snaps.find(s => !s.empty);
  if (!match) return twiml('Phone number not registered with Relay. Visit portal-relay.com to set up your account.');

  const userDoc  = match.docs[0];
  const uid      = userDoc.id;
  const profile  = userDoc.data();
  const plan     = (profile.plan || 'starter').toLowerCase();
  const subStatus = profile.subscriptionStatus || 'unpaid';

  // ── Tier gate: Starter ────────────────────────────────────────────────────
  if (!canSMSDispatch(plan)) {
    return twiml('SMS Dispatch requires an Essential or Essential+ plan. Upgrade at portal-relay.com');
  }

  // ── Subscription active check ─────────────────────────────────────────────
  if (!isActiveStatus(subStatus)) {
    return twiml('Your Relay subscription is inactive. Visit portal-relay.com to reactivate.');
  }

  // ── AI: parse + professionalize raw SMS ──────────────────────────────────
  let parsed;
  try {
    const aiRes = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a professional field-service document assistant. A technician sent this raw SMS:

"${body}"

Extract job details and return ONLY valid JSON (no markdown, no explanation):
{
  "job_type": "repair|install|inspection|quote|other",
  "customer_name": "",
  "customer_phone": "",
  "customer_email": "",
  "address": "",
  "amount": 0,
  "professional_description": "2-4 sentence professional write-up of the work performed",
  "confidence": 0.0
}
If a field is unknown, use empty string or 0.`,
      }],
    });
    parsed = JSON.parse(aiRes.content[0].text.trim());
  } catch (err) {
    console.error('AI parse error:', err);
    return twiml('Relay AI could not process your message. Please try again with more detail.');
  }

  // ── Save invoice to Firestore ─────────────────────────────────────────────
  const invoiceData = {
    customer:       parsed.customer_name    || 'Unknown',
    phone:          parsed.customer_phone   || '',
    email:          parsed.customer_email   || '',
    address:        parsed.address          || '',
    amount:         parsed.amount           || 0,
    work:           parsed.professional_description || body,
    rawSms:         body,
    type:           parsed.job_type === 'quote' ? 'quote' : 'invoice',
    status:         'pending',
    source:         'sms',
    plan,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  };
  const invRef = await db.collection('users').doc(uid).collection('invoices').add(invoiceData);

  // ── Essential+: auto-forward doc to customer ──────────────────────────────
  if (canAutoForward(plan) && profile.autoForwardToCustomer && parsed.customer_phone) {
    const docType = invoiceData.type === 'quote' ? 'Quote' : 'Invoice';
    const fwdMsg = `Hi ${parsed.customer_name || 'there'}, your ${docType} from ${profile.companyName || 'your contractor'} is ready:

${parsed.professional_description}

Amount: $${parsed.amount || 'TBD'}

Questions? Reply to this message.`;
    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to:   parsed.customer_phone,
      body: fwdMsg,
    }).catch(e => console.error('Auto-forward failed:', e));
  }

  // ── Essential+: review request SMS (send after a delay via queue flag) ─────
  // Flag in Firestore — a scheduled function can pick this up, or send immediately
  if (canAutoForward(plan) && profile.reviewUrl && parsed.customer_phone) {
    await db.collection('review_requests').add({
      uid,
      customerPhone: parsed.customer_phone,
      customerName:  parsed.customer_name || 'there',
      companyName:   profile.companyName  || 'your contractor',
      reviewUrl:     profile.reviewUrl,
      invoiceId:     invRef.id,
      status:        'pending',
      scheduledFor:  new Date(Date.now() + 24 * 60 * 60 * 1000), // 24hr later
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── Reply to technician ───────────────────────────────────────────────────
  const preview = (parsed.professional_description || '').slice(0, 120);
  const replyLines = [
    'Relay AI dispatched your job.',
    `Type: ${invoiceData.type} | Amount: $${parsed.amount || 'TBD'}`,
    `"${preview}${preview.length < (parsed.professional_description || '').length ? '...' : ''}"`,
  ];
  if (canAutoForward(plan) && profile.autoForwardToCustomer && parsed.customer_phone) {
    replyLines.push('Doc sent to customer via SMS.');
  }
  return twiml(replyLines.join('\n'));
};

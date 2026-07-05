// netlify/functions/twilio-sms.js
// Receives inbound SMS from Twilio dispatch line
// Uses Claude AI to parse raw tech notes into professional invoices/quotes
// Saves to Firestore and confirms back via SMS

const Anthropic = require('@anthropic-ai/sdk');
const admin     = require('firebase-admin');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'pryorpropertysolutions269@gmail.com';

// Firebase Admin init (once)
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- Handler ---------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse Twilio form-encoded POST body
  const params      = new URLSearchParams(event.body);
  const fromNumber  = params.get('From')  || '';
  const messageBody = params.get('Body')  || '';

  console.log('SMS in | from:', fromNumber, '| body:', messageBody);

  if (!messageBody.trim()) {
    return twiml('Got your message but it was empty. Please include job details and try again.');
  }

  try {
    // 1. Find Relay user by their registered phone number
    const userSnap = await db.collection('users')
      .where('phoneNumber', '==', fromNumber)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return twiml(
        'Your number is not linked to a Relay account. ' +
        'Sign up at portal-relay.com then add your phone number in your profile.'
      );
    }

    const userDoc  = userSnap.docs[0];
    const userId   = userDoc.id;
    const profile  = userDoc.data();

    // 2. Check subscription is active
    const subStatus = profile.subscriptionStatus || 'unpaid';
    const ACTIVE    = new Set(['active', 'trialing', 'past_due']);
    if (!ACTIVE.has(subStatus) && profile.email !== ADMIN_EMAIL) {
      return twiml(
        'Your Relay subscription is not active. ' +
        'Visit portal-relay.com to reactivate your account.'
      );
    }

    // 3. Call Claude to parse + professionalize the raw SMS
    const aiResult = await callClaude(messageBody);
    if (!aiResult) {
      return twiml('Could not process that message. Please include more detail and try again.');
    }

    // 4. Save invoice/quote to Firestore
    const ts  = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      type:          aiResult.job_type    || 'invoice',
      customer:      aiResult.customer_name  || 'Unknown',
      customerPhone: aiResult.customer_phone || null,
      customerEmail: aiResult.customer_email || null,
      address:       aiResult.address        || null,
      amount:        aiResult.amount         || 0,
      work:          aiResult.professional_description,
      rawText:       messageBody,
      status:        'pending',
      source:        'sms',
      createdAt:     ts,
      updatedAt:     ts,
    };

    const ref = await db
      .collection('users').doc(userId)
      .collection('invoices').add(doc);

    console.log('Created', doc.type, ref.id, 'for user', userId);

    // 5. Reply with confirmation + preview
    const amtStr      = aiResult.amount  ? '$' + aiResult.amount : '(no amount detected — update in portal)';
    const custStr     = aiResult.customer_name || 'your customer';
    const typeStr     = doc.type === 'quote' ? 'Quote' : 'Invoice';
    const preview     = (aiResult.professional_description || '').substring(0, 120);

    const reply =
      typeStr + ' created for ' + custStr + ' — ' + amtStr + '\n\n' +
      '"' + preview + (preview.length >= 120 ? '...' : '') + '"\n\n' +
      'Review & send at portal-relay.com';

    return twiml(reply);

  } catch (err) {
    console.error('twilio-sms error:', err);
    return twiml('Something went wrong. Please try again in a moment.');
  }
};

// ---- Claude call -----------------------------------------------------------
async function callClaude(rawText) {
  const prompt = `You are the AI engine for Relay, a dispatch and invoicing platform for tradespeople and contractors.

A technician just texted in a job. Your job is to:
1. Parse any structured details (customer name, phone, address, amount, job type)
2. Write a professional 2-4 sentence description of the work for the customer-facing document

Raw technician text:
"${rawText}"

Return ONLY valid JSON — no markdown, no explanation:
{
  "job_type": "invoice" or "quote",
  "customer_name": string or null,
  "customer_phone": string or null,
  "customer_email": string or null,
  "address": string or null,
  "amount": number or null,
  "professional_description": "2-4 sentence professional description written for the customer. Past tense for invoices, future tense for quotes. Expand the raw notes into a complete, polished description. Do NOT include pricing here.",
  "confidence": "high" or "medium" or "low"
}

Professional description guidelines:
- Start with what the problem/request was
- Describe what was done to resolve it
- End with the outcome/result
- Use professional trade language but keep it readable for a homeowner
- Do NOT use the phrase 'our technician' — write from the contractor's perspective`;

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    });

    return JSON.parse(msg.content[0].text);
  } catch (err) {
    console.error('Claude error:', err);
    return null;
  }
}

// ---- TwiML helper ----------------------------------------------------------
function twiml(message) {
  return {
    statusCode: 200,
    headers:    { 'Content-Type': 'text/xml' },
    body:       `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`,
  };
}

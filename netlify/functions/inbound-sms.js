// netlify/functions/inbound-sms.js
// Handles inbound SMS dispatches from contractors via Twilio.
// Parses job details with Claude AI, saves to Firestore, confirms to contractor.
//
// Required Netlify env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   FIREBASE_SERVICE_ACCOUNT_JSON  (full service account JSON as a string)
//   ANTHROPIC_API_KEY

const Anthropic = require('@anthropic-ai/sdk');
const admin     = require('firebase-admin');
const twilio    = require('twilio');

// ── Firebase Admin (singleton) ────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    ),
  });
}
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFormBody(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function normalizePhone(raw) {
  return raw.replace(/\D/g, '').replace(/^1/, '');
}

function twimlOK() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  };
}

async function sendSMS(to, body) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  await client.messages.create({
    from: process.env.TWILIO_FROM_NUMBER || '+18447291376',
    to,
    body,
  });
}

async function parseDispatch(messageText) {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Extract job dispatch details from this contractor text message.
Return ONLY valid JSON — no markdown, no explanation:

{
  "customerName": "string or null",
  "customerPhone": "digits only, 10 or 11 digits, or null",
  "jobAddress": "string or null",
  "workDescription": "string or null",
  "amount": number or null,
  "documentType": "invoice" or "quote"
}

Set documentType to "quote" if the message mentions estimate, bid, or quote. Otherwise "invoice".
Set any field to null if not present in the message.

Contractor message: ${messageText}`,
      },
    ],
  });

  const text  = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

// ── Main Handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let fromNumber, messageBody;

  try {
    const params = parseFormBody(event.body);
    fromNumber  = params.From;
    messageBody = (params.Body || '').trim();
    if (!fromNumber || !messageBody) return twimlOK();
  } catch (err) {
    console.error('Webhook parse error:', err);
    return twimlOK();
  }

  const normalizedPhone = normalizePhone(fromNumber);

  try {
    // ── 1. Look up contractor in Firestore ─────────────────────────────────
    const snap = await db
      .collection('users')
      .where('phone', '==', normalizedPhone)
      .limit(1)
      .get();

    if (snap.empty) {
      await sendSMS(
        fromNumber,
        'Hi! We don\'t recognize this number in RelayAI.\n' +
        'Sign up at portal-relay.com to get started.'
      );
      return twimlOK();
    }

    const userDoc  = snap.docs[0];
    const userId   = userDoc.id;
    const userData = userDoc.data();

    // ── 2. Parse the dispatch text with Claude ─────────────────────────────
    let job;
    try {
      job = await parseDispatch(messageBody);
    } catch (err) {
      console.error('Claude parse error:', err);
      await sendSMS(
        fromNumber,
        'We had trouble reading that dispatch. Please include:\n' +
        '• Customer name + phone\n' +
        '• Job address\n' +
        '• Work done\n' +
        '• Amount\n\n' +
        'Example: John Smith 555-1234, 400 Oak Ave, replaced water heater, $850'
      );
      return twimlOK();
    }

    // ── 3. Ask for anything missing ────────────────────────────────────────
    const missing = [];
    if (!job.customerName)    missing.push('customer name');
    if (!job.customerPhone)   missing.push('customer phone number');
    if (!job.jobAddress)      missing.push('job address');
    if (!job.workDescription) missing.push('description of work done');
    if (!job.amount)          missing.push('amount');

    if (missing.length > 0) {
      await sendSMS(
        fromNumber,
        `Almost there! Just missing: ${missing.join(', ')}.\n` +
        `Reply with the missing info and we'll send the ${job.documentType} right out.`
      );
      return twimlOK();
    }

    // ── 4. Save job to Firestore ───────────────────────────────────────────
    const jobRef = await db
      .collection('users')
      .doc(userId)
      .collection('jobs')
      .add({
        customerName:    job.customerName,
        customerPhone:   job.customerPhone,
        jobAddress:      job.jobAddress,
        workDescription: job.workDescription,
        amount:          job.amount,
        documentType:    job.documentType,
        status:          'pending_document',
        source:          'sms',
        rawMessage:      messageBody,
        contractorName:  userData.companyName || '',
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`Job ${jobRef.id} created for user ${userId}`);

    // ── 5. Confirm back to contractor ──────────────────────────────────────
    const label = job.documentType === 'quote' ? 'Quote' : 'Invoice';
    await sendSMS(
      fromNumber,
      `✓ Got it! ${label} for ${job.customerName} — $${Number(job.amount).toLocaleString()}\n` +
      `📍 ${job.jobAddress}\n\n` +
      `Generating their ${label.toLowerCase()} now and sending to ${job.customerPhone}.\n` +
      `View your portal: portal-relay.com`
    );

    // ── 6. TODO: trigger PDF generation + customer delivery ────────────────
    // Next build: generate-document.js
    // Receives { jobId, userId }, builds branded PDF, SMS link to customer.

    return twimlOK();

  } catch (err) {
    console.error('Handler error:', err);
    try {
      await sendSMS(fromNumber, 'Something went wrong on our end. Please try again in a moment.');
    } catch (_) {}
    return twimlOK(); // Always return 200 to Twilio
  }
};

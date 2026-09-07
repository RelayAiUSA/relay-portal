// relay-pwa/functions/twilio-sms.mjs
// Receives inbound SMS from Twilio, dispatches AI-generated invoice/quote via SMS.
//
// Tier gating:
//   starter   → upgrade prompt only
//   essential → AI parse + dispatch + accounting sync
//   pro       → all essential features + auto-forward to customer + review request SMS

import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { syncInvoiceToAccounting } from './lib/accounting-sync.mjs';

// ── Firebase Admin init ───────────────────────────────────────────────────────

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

// ── Clients ───────────────────────────────────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER || '+18447291376';

// ── Plan helpers ──────────────────────────────────────────────────────────────

function canSMSDispatch(plan) {
  return ['essential', 'pro'].includes((plan || '').toLowerCase());
}
function canAutoForward(plan) {
  return (plan || '').toLowerCase() === 'pro';
}
function isActiveStatus(status) {
  return ['active', 'trialing', 'past_due'].includes(status);
}

// ── TwiML reply ───────────────────────────────────────────────────────────────

function twiml(msg) {
  // Escape XML special chars so the message is safe inside a TwiML element
  const safe = String(msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params    = new URLSearchParams(req.body || '');
  const fromPhone = params.get('From') || '';
  const body      = (params.get('Body') || '').trim();

  if (!fromPhone || !body) return twiml('Missing phone or message body.');

  // ── Look up Relay user by phoneNumber field ───────────────────────────────
  const normalised = fromPhone.replace(/\D/g, '');
  const snaps = await Promise.all([
    db.collection('users').where('phoneNumber', '==', fromPhone).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', '+' + normalised).limit(1).get(),
    db.collection('users').where('phoneNumber', '==', normalised).limit(1).get(),
  ]);
  const match = snaps.find(s => !s.empty);
  if (!match) {
    return twiml('Phone number not registered with Relay. Visit portal-relay.com to set up your account.');
  }

  const userDoc  = match.docs[0];
  const uid      = userDoc.id;
  const profile  = userDoc.data();
  const plan     = (profile.plan || 'starter').toLowerCase();
  const subStatus = profile.subscriptionStatus || 'unpaid';

  // ── Tier gate: Starter ────────────────────────────────────────────────────
  if (!canSMSDispatch(plan)) {
    return twiml('SMS Dispatch requires an Essential or Pro plan. Upgrade at portal-relay.com');
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
        role:    'user',
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
    console.error('[twilio-sms] AI parse error:', err);
    return twiml('Relay AI could not process your message. Please try again with more detail.');
  }

  // ── Save invoice to Firestore ─────────────────────────────────────────────
  const invoiceData = {
    customer_name:            parsed.customer_name  || 'Unknown',
    customer_phone:           parsed.customer_phone || '',
    customer_email:           parsed.customer_email || '',
    address:                  parsed.address        || '',
    amount:                   parsed.amount         || 0,
    professional_description: parsed.professional_description || body,
    job_type:                 parsed.job_type       || 'other',
    rawSms:                   body,
    type:                     parsed.job_type === 'quote' ? 'quote' : 'invoice',
    status:                   'pending',
    source:                   'sms',
    plan,
    reviewRequestSent:        false,
    createdAt:                FieldValue.serverTimestamp(),
    sentAt:                   FieldValue.serverTimestamp(),
  };
  const invRef = await db.collection('users').doc(uid).collection('invoices').add(invoiceData);

  // ── Accounting sync (Essential + Pro, invoices only) ─────────────────────
  // syncInvoiceToAccounting never throws — outcome is recorded on the invoice doc.
  let syncResult = { synced: false, reason: 'not_connected' };
  if (invoiceData.type !== 'quote') {
    syncResult = await syncInvoiceToAccounting(db, uid, invRef.id, invoiceData, profile);
  }

  // ── Pro: auto-forward doc to customer via SMS ─────────────────────────────
  if (canAutoForward(plan) && profile.autoForwardToCustomer && parsed.customer_phone) {
    const docType = invoiceData.type === 'quote' ? 'Quote' : 'Invoice';
    const fwdMsg  = [
      `Hi ${parsed.customer_name || 'there'}, your ${docType} from ${profile.companyName || 'your contractor'} is ready:`,
      '',
      parsed.professional_description,
      '',
      `Amount: $${parsed.amount || 'TBD'}`,
      '',
      'Questions? Reply to this message.',
    ].join('\n');
    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to:   parsed.customer_phone,
      body: fwdMsg,
    }).catch(e => console.error('[twilio-sms] Auto-forward failed:', e));
  }

  // ── Pro: queue review request for the scheduled review-request function ───
  // review-request.mjs picks up documents in the invoices collection where
  // reviewRequestSent == false — no separate collection needed.
  // (reviewRequestSent is already false in invoiceData above)

  // ── Reply to technician ───────────────────────────────────────────────────
  const description = parsed.professional_description || '';
  const preview     = description.length > 120 ? description.slice(0, 120) + '...' : description;
  const replyLines  = [
    'Relay AI dispatched your job.',
    `Type: ${invoiceData.type} | Amount: $${parsed.amount || 'TBD'}`,
    `"${preview}"`,
  ];

  if (canAutoForward(plan) && profile.autoForwardToCustomer && parsed.customer_phone) {
    replyLines.push('Doc sent to customer via SMS.');
  }

  if (invoiceData.type !== 'quote') {
    if (syncResult.synced) {
      const label = syncResult.provider === 'quickbooks' ? 'QuickBooks' : 'Zoho Books';
      replyLines.push(`Synced to ${label} (#${syncResult.externalNumber || syncResult.externalId}).`);
    } else if (syncResult.reason === 'not_connected' || syncResult.reason === 'no_provider') {
      replyLines.push('Connect your accounting software at portal-relay.com to auto-sync invoices.');
    } else {
      replyLines.push('Saved, but accounting sync failed — check portal-relay.com.');
    }
  }

  return twiml(replyLines.join('\n'));
}

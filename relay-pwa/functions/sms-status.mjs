// relay-pwa/functions/sms-status.mjs
// Twilio delivery-status callback.
//
// Handing a message to Twilio is not the same as a phone receiving it. Twilio
// accepts a message, returns a SID, and only later learns from the carrier
// whether it was delivered, filtered or rejected. Without this endpoint that
// second half is invisible to Relay: the log said "reply sent" and the
// contractor's phone stayed silent, with no way to tell a carrier block from a
// bug in our own code short of logging into the Twilio console.
//
// Twilio POSTs here on every status transition. The terminal failures are the
// ones worth acting on:
//   30032  the toll-free number is not verified yet
//   30007  the carrier filtered the message as spam
//   30003  the handset is unreachable
//   21610  the recipient replied STOP
//
// The endpoint is public, so it validates X-Twilio-Signature exactly as
// twilio-sms does - otherwise anyone could forge failures and trigger alerts.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                   from 'firebase-admin/firestore';
import { validateTwilioSignature }        from './lib/twilio-signature.mjs';
import { alertError }                     from './lib/alert.mjs';
import { suppressNumber }                 from './lib/suppression.mjs';

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

// Delivery outcomes that mean the recipient did NOT get the message.
const FAILED_STATUSES = new Set(['failed', 'undelivered']);

// Twilio's own explanations, so the log answers the question without a lookup.
const ERROR_HINTS = {
  '30032': 'The toll-free number is not verified. Carriers block unverified toll-free traffic - this clears when Twilio approves the verification.',
  '30007': 'The carrier filtered this message as spam.',
  '30008': 'Unknown carrier error.',
  '30003': 'The destination handset is unreachable or powered off.',
  '30005': 'The destination number does not exist.',
  '30006': 'The destination is a landline or cannot receive SMS.',
  '21610': 'The recipient has replied STOP and is unsubscribed.',
};

export default async (req) => {
  try {
    return await handleStatus(req);
  } catch (err) {
    console.error('[sms-status] unhandled error:', err);
    try {
      await alertError('sms-status:unhandled', err);
    } catch (alertErr) {
      console.error('[sms-status] alert failed:', alertErr?.message);
    }
    // Twilio retries 5xx. A failure to log a status is not worth a retry storm.
    return new Response('', { status: 204 });
  }
};

async function handleStatus(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const raw    = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  const authToken     = process.env.TWILIO_AUTH_TOKEN;
  const validationOff = process.env.TWILIO_SIGNATURE_VALIDATION === 'off';
  if (!validationOff) {
    if (!authToken || !validateTwilioSignature(req, params, authToken)) {
      console.warn('[sms-status] rejected a request with an invalid signature');
      return new Response('Forbidden', { status: 403 });
    }
  }

  const sid       = params.MessageSid    || params.SmsSid    || '';
  const status    = params.MessageStatus || params.SmsStatus || '';
  const to        = params.To || '';
  const errorCode = params.ErrorCode || '';

  // 21610 means the carrier refused because this consumer replied STOP. That is
  // the only notification Relay gets when the STOP went to Twilio rather than to
  // our webhook, so it is where the opt-out has to be captured - otherwise the
  // suppression lives only inside Twilio and is lost the moment we add a second
  // sending number or change providers.
  if (errorCode === '21610') {
    await suppressNumber(db, to, { reason: 'carrier_21610', sid });
  }

  if (FAILED_STATUSES.has(status)) {
    const hint = ERROR_HINTS[errorCode] || 'See Twilio error code reference.';
    // ERROR level so it stands out in the function log next to the send line
    // that reported success moments earlier.
    console.error(`[sms-status] ${status.toUpperCase()} sid=${sid} to=${to} errorCode=${errorCode || 'none'} - ${hint}`);
  } else {
    console.log(`[sms-status] ${status} sid=${sid} to=${to}`);
  }

  return new Response('', { status: 204 });
}

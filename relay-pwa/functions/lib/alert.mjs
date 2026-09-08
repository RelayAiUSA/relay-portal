// relay-pwa/functions/lib/alert.mjs
// Sends an SMS alert to the owner phone when a function hits a fatal error.
//
// Required env var (Netlify dashboard > Site > Environment variables):
//   ALERT_PHONE  — owner's personal cell in E.164 format, e.g. +12695550100
//
// If ALERT_PHONE is not set, the error is only logged (safe fallback).

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+18447291376';
const ALERT_PHONE  = process.env.ALERT_PHONE;

export async function alertError(functionName, err, context = '') {
  const msg = `⚠️ Relay function error\nFn: ${functionName}\nErr: ${String(err?.message || err).slice(0, 120)}${context ? '\n' + context : ''}`;
  console.error(`[alert] ${msg}`);

  if (!ALERT_PHONE || !TWILIO_SID || !TWILIO_TOKEN) return; // no-op if not configured

  try {
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method:  'POST',
        headers: {
          Authorization:  'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: ALERT_PHONE, Body: msg }).toString(),
      }
    );
  } catch (e) {
    console.error('[alert] Failed to send alert SMS:', e.message);
  }
}

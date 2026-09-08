// relay-pwa/functions/lib/alert.mjs
//
// One call, two destinations:
//   Sentry — the durable record. Full stack trace, grouping, counts, history.
//            This is where you go to actually diagnose something.
//   SMS    — the interrupt. Only for things worth waking someone up.
//
// Env:
//   SENTRY_DSN   — see lib/sentry.mjs. Unset = Sentry reporting is skipped.
//   ALERT_PHONE  — owner's cell, E.164. Unset = SMS is skipped.
//
// Neither destination can break the caller: alerting about a failure must
// never itself become a failure, and must never mask the original error.

import { captureException } from './sentry.mjs';

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER || '+18447291376';
const ALERT_PHONE  = process.env.ALERT_PHONE;

// ── SMS throttling ───────────────────────────────────────────────────────────
// Without this, one bug in a loop means one text per occurrence: a dead phone
// and a Twilio bill, for information the first text already conveyed. Sentry
// keeps every occurrence, so suppressing duplicate texts loses nothing.
//
// Module scope, so the memory lasts as long as a warm container. Cold starts
// reset it, which is why there is also a hard per-container ceiling.
const SMS_REPEAT_WINDOW_MS = 15 * 60 * 1000;
const SMS_MAX_PER_CONTAINER = 5;
const lastSmsAt = new Map();
let smsSentThisContainer = 0;

export function signature(functionName, err) {
  return `${functionName}|${String(err?.message || err).slice(0, 80)}`;
}

/**
 * Pure throttle decision. All state is passed in, so the real logic used in
 * production is the same logic a test can exercise directly - no
 * re-implementation, which is only ever a test of itself.
 */
export function smsDecision({ key, now, lastMap, sentCount, configured }) {
  if (!configured)                            return { send: false, reason: 'not_configured' };
  if (sentCount >= SMS_MAX_PER_CONTAINER)     return { send: false, reason: 'container_cap' };
  const last = lastMap.get(key);
  if (last !== undefined && now - last < SMS_REPEAT_WINDOW_MS)
                                              return { send: false, reason: 'duplicate_window' };
  return { send: true, reason: 'ok', key };
}

/** Records that an SMS went out. Exported so tests can drive the real state. */
export function recordSmsSent(lastMap, key, now) {
  lastMap.set(key, now);
}

export const _throttle = { lastSmsAt, SMS_REPEAT_WINDOW_MS, SMS_MAX_PER_CONTAINER };

function shouldSendSms(functionName, err, now = Date.now()) {
  return smsDecision({
    key:        signature(functionName, err),
    now,
    lastMap:    lastSmsAt,
    sentCount:  smsSentThisContainer,
    configured: !!(ALERT_PHONE && TWILIO_SID && TWILIO_TOKEN),
  });
}

export async function alertError(functionName, err, context = '') {
  const msg = `⚠️ Relay function error\nFn: ${functionName}\nErr: ${String(err?.message || err).slice(0, 120)}${context ? '\n' + context : ''}`;
  console.error(`[alert] ${msg}`);

  // Sentry first: it is the record that must not be lost, and it is never
  // throttled. Every occurrence is captured and grouped there.
  try {
    await captureException(err, {
      fn: functionName,
      extra: context ? { context } : {},
    });
  } catch (e) {
    console.error('[alert] Sentry capture failed:', e?.message);
  }

  const decision = shouldSendSms(functionName, err);
  if (!decision.send) {
    if (decision.reason !== 'not_configured') {
      console.warn(`[alert] SMS suppressed (${decision.reason}) — see Sentry for this error`);
    }
    return;
  }

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
    recordSmsSent(lastSmsAt, decision.key, Date.now());
    smsSentThisContainer++;
  } catch (e) {
    console.error('[alert] Failed to send alert SMS:', e.message);
  }
}

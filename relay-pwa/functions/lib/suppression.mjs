// relay-pwa/functions/lib/suppression.mjs
//
// Platform-wide do-not-text list, and the quiet-hours window.
//
// WHY THIS EXISTS
//
// STOP was only ever handled by Twilio. Twilio blocks a message to a number
// that has opted out and returns error 21610 - but Relay's own database still
// believed that person was textable. Three ways that bites:
//
//   1. The same consumer is a customer of two different contractors on Relay.
//      They reply STOP to one. Twilio's opt-out is per sending number, so with
//      a single shared number they are suppressed for both - but Relay would
//      still record the second contractor's message as "sent" and keep trying,
//      burning carrier reputation on a number that will never receive.
//   2. If Relay ever adds a second sending number or changes providers, every
//      opt-out held only inside Twilio is silently lost.
//   3. A contractor could edit or re-add the customer record and Relay would
//      cheerfully text an opted-out consumer again. That is the exact fact
//      pattern a TCPA claim is built on.
//
// An opt-out belongs to the CONSUMER, not to a contractor's customer record, so
// it lives in a top-level collection keyed by the phone number and it outranks
// every consent record. Nothing a contractor can do in the portal clears it.
//
// This collection is written only by the Admin SDK. It has no client rule and
// therefore falls through firestore.rules' deny-all, which is correct.

import { normalizePhone } from './consent.mjs';

const COLLECTION = 'smsSuppressions';

// Keywords a consumer can text to stop messages. Twilio recognises the
// standard set itself; Relay recognises them too so the opt-out is recorded
// here even when the message reaches our webhook.
const STOP_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stopped', 'optout', 'opt-out',
]);
const START_WORDS = new Set(['start', 'unstop', 'yes subscribe', 'resubscribe']);

export function isStopKeyword(body) {
  return STOP_WORDS.has(String(body || '').trim().toLowerCase().replace(/[.!]+$/, ''));
}
export function isStartKeyword(body) {
  return START_WORDS.has(String(body || '').trim().toLowerCase().replace(/[.!]+$/, ''));
}

/**
 * Record a permanent opt-out for a phone number.
 * Never throws - a suppression write failing must not break the caller.
 */
export async function suppressNumber(db, phone, { reason = 'stop_keyword', uid = null, sid = null } = {}) {
  const key = normalizePhone(phone);
  if (!key) return false;
  try {
    await db.collection(COLLECTION).doc(key).set({
      phoneDigits:  key,
      suppressed:   true,
      reason,                       // stop_keyword | carrier_21610 | manual
      suppressedAt: new Date(),
      lastUid:      uid,            // which account was sending when it happened
      lastSid:      sid,
    }, { merge: true });
    console.log(`[suppression] ${key} suppressed (${reason})`);
    return true;
  } catch (err) {
    console.error('[suppression] write failed:', err.message);
    return false;
  }
}

/** Clear an opt-out. Only a START keyword from the consumer themselves. */
export async function unsuppressNumber(db, phone) {
  const key = normalizePhone(phone);
  if (!key) return false;
  try {
    await db.collection(COLLECTION).doc(key).set({
      phoneDigits: key,
      suppressed:  false,
      resumedAt:   new Date(),
    }, { merge: true });
    console.log(`[suppression] ${key} resumed by START`);
    return true;
  } catch (err) {
    console.error('[suppression] resume failed:', err.message);
    return false;
  }
}

/**
 * Is this number on the do-not-text list?
 * Fails CLOSED: if the lookup errors we treat the number as suppressed, because
 * texting someone who opted out is far more costly than missing one message.
 */
export async function isSuppressed(db, phone) {
  const key = normalizePhone(phone);
  if (!key) return true;
  try {
    const snap = await db.collection(COLLECTION).doc(key).get();
    return snap.exists ? snap.data().suppressed === true : false;
  } catch (err) {
    console.error('[suppression] lookup failed, failing closed:', err.message);
    return true;
  }
}

// -- Quiet hours -------------------------------------------------------------
//
// The TCPA restricts calls and texts before 8am and after 9pm in the
// RECIPIENT'S local time. Relay sent whenever a job happened to be texted in,
// so a contractor finishing at 9:30pm generated a violation automatically.
//
// We do not ask consumers for their time zone, so the area code is the best
// available signal. It is not perfect - people keep numbers when they move -
// but it is the standard industry proxy and it is far better than sending
// blind. Unknown area codes fall back to Eastern, the most conservative choice
// for a US-wide window: Eastern reaches 9pm first, so holding to Eastern never
// sends late anywhere else in the country.

const QUIET_START_HOUR = 8;   // inclusive - first hour it is OK to send
const QUIET_END_HOUR   = 21;  // exclusive - 21:00 is the cutoff

const AREA_CODE_ZONES = {
  central:  ['205','251','256','334','479','501','870','217','224','309','312','331','618','630','708','773','779','815','847','872','219','260','574','812','316','620','785','913','270','502','606','859','225','318','337','504','985','218','320','507','612','651','763','952','314','417','573','636','660','816','308','402','531','601','662','769','580','405','539','918','210','214','254','281','325','361','409','430','432','469','512','682','713','737','806','817','830','832','903','915','936','940','956','972','979','262','414','534','608','715','920'],
  mountain: ['303','719','720','970','208','986','406','505','575','385','435','801','307','480','520','602','623','928'],
  pacific:  ['206','253','360','425','509','564','503','458','541','971','209','213','279','310','323','341','408','415','424','442','510','530','559','562','619','626','628','650','657','661','669','707','714','747','760','805','818','820','831','858','909','916','925','949','951','702','725','775'],
  alaska:   ['907'],
  hawaii:   ['808'],
};
const ZONE_IDS = {
  central:  'America/Chicago',
  mountain: 'America/Denver',
  pacific:  'America/Los_Angeles',
  alaska:   'America/Anchorage',
  hawaii:   'Pacific/Honolulu',
  eastern:  'America/New_York',
};

export function timeZoneForPhone(phone) {
  const key = normalizePhone(phone);
  const area = key.slice(0, 3);
  for (const [zone, codes] of Object.entries(AREA_CODE_ZONES)) {
    if (codes.includes(area)) return ZONE_IDS[zone];
  }
  return ZONE_IDS.eastern;
}

/** The recipient's local hour (0-23), from their area code. */
export function localHourForPhone(phone, now = new Date()) {
  const tz = timeZoneForPhone(phone);
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).format(now);
  return parseInt(hour, 10) % 24;
}

/**
 * May we text this number right now?
 * @returns {{ ok: boolean, hour: number, zone: string }}
 */
export function withinQuietHours(phone, now = new Date()) {
  const zone = timeZoneForPhone(phone);
  const hour = localHourForPhone(phone, now);
  return { ok: hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR, hour, zone };
}

// relay-pwa/functions/lib/twilio-signature.mjs
//
// Validates Twilio's X-Twilio-Signature header on inbound webhook requests.
//
// Why this exists:
//   /.netlify/functions/twilio-sms is a public, unauthenticated endpoint. Without
//   this check, anyone who knows the URL can POST From=<a contractor's number>
//   and forge a job into that account: it creates a real invoice, spends an
//   Anthropic call, and syncs a fabricated invoice to their QuickBooks or Zoho.
//   Phone numbers are not secrets, so "they'd have to guess the number" is not a
//   control. stripe-webhook already verifies its Stripe signature; this brings
//   the Twilio path to the same standard.
//
// Algorithm (Twilio, https://www.twilio.com/docs/usage/security):
//   1. Start with the full request URL, including protocol, host, path and query.
//   2. Append every POST parameter sorted alphabetically by key, Unix-style
//      case-sensitive (uppercase before lowercase), concatenating key then value
//      with no delimiter.
//   3. HMAC-SHA1 the result, keyed with the account's auth token.
//   4. Base64-encode, and compare against the header.
//
// Verified against Twilio's published worked example in this module's self-test.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the expected signature for a URL and set of POST params.
 * @param {string} authToken
 * @param {string} url      full URL including query string
 * @param {Record<string,string>} params  POST params
 * @returns {string} base64 signature
 */
export function computeSignature(authToken, url, params) {
  // Unix-style case-sensitive sort: plain code-unit ordering, NOT localeCompare.
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Candidate public URLs for this request.
 *
 * Netlify sits behind a proxy, so the URL the runtime sees may not be the one
 * Twilio signed. Rather than guess a single form, try the plausible ones and
 * accept if any matches — a false reject silently breaks every inbound text.
 */
export function candidateUrls(req) {
  const out = [];
  const push = (u) => { if (u && !out.includes(u)) out.push(u); };

  push(req.url);

  try {
    const u = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const host  = req.headers.get('x-forwarded-host') || req.headers.get('host') || u.host;
    push(`${proto}://${host}${u.pathname}${u.search}`);
    // Twilio is configured with the apex domain; include it explicitly in case
    // the request arrives via a Netlify subdomain.
    push(`https://portal-relay.com${u.pathname}${u.search}`);
    // Some proxies present the path without the query string.
    if (u.search) push(`${proto}://${host}${u.pathname}`);
  } catch {
    // req.url was not absolute; the candidates above are the best available.
  }
  return out;
}

/**
 * @returns {{valid: boolean, reason: string}}
 */
export function validateTwilioSignature(req, params, authToken) {
  if (String(process.env.TWILIO_SIGNATURE_VALIDATION || '').toLowerCase() === 'off') {
    return { valid: true, reason: 'validation_disabled_by_env' };
  }
  if (!authToken) return { valid: false, reason: 'no_auth_token_configured' };

  const provided = req.headers.get('x-twilio-signature');
  if (!provided) return { valid: false, reason: 'missing_signature_header' };

  for (const url of candidateUrls(req)) {
    if (safeEqual(provided, computeSignature(authToken, url, params))) {
      return { valid: true, reason: 'ok' };
    }
  }
  return { valid: false, reason: 'signature_mismatch' };
}

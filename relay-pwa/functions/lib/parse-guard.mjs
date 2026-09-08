// relay-pwa/functions/lib/parse-guard.mjs
//
// Sanitises and sanity-checks the model's parsed job details before they become
// a real financial document.
//
// Why this exists:
//   twilio-sms JSON.parsed the model's reply and wrote parsed.amount and
//   parsed.customer_phone straight onto an invoice. Nothing checked the type,
//   range or format. A single bad parse could bill someone $999,999 — under the
//   CONTRACTOR'S business name, not Relay's. The contractor wears that mistake
//   with their own customer, which is the kind of failure that loses an account
//   permanently.
//
// The guard never invents data. It coerces what is usable, discards what is
// not, and flags anything a human should look at before it goes out.

// A job over this is almost certainly a misparse (a phone number or a date read
// as a price). Not a hard ceiling on real work — the document is still created,
// it is just held for review instead of auto-sent.
export const AMOUNT_REVIEW_THRESHOLD = 50000;
export const AMOUNT_HARD_MAX         = 10000000;   // 10M: refuse outright
export const MAX_DESCRIPTION_CHARS   = 2000;
export const MIN_CONFIDENCE          = 0.4;

const JOB_TYPES = ['repair', 'install', 'inspection', 'quote', 'other'];

/** Models sometimes wrap JSON in markdown fences despite instructions. */
export function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : t;
  return JSON.parse(candidate);
}

/** Digits only, last 10 for US numbers; '' if it cannot be a real number. */
export function cleanPhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length > 11 && d.length <= 15) return '+' + d;   // plausible international
  return '';
}

export function cleanEmail(raw) {
  const e = String(raw ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e) ? e : '';
}

/**
 * @returns {{clean: object, flags: string[], needsReview: boolean, fatal: string|null}}
 */
export function guardParsedJob(parsed, rawBody) {
  const flags = [];
  let fatal = null;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { clean: null, flags: ['not_an_object'], needsReview: true, fatal: 'not_an_object' };
  }

  // ── amount ────────────────────────────────────────────────────────────────
  // Accept "1,250.00" and "$1250" as well as a number; anything else is 0.
  let amount = parsed.amount;
  if (typeof amount === 'string') amount = Number(amount.replace(/[$,\s]/g, ''));
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    amount = 0;
    flags.push('amount_unparseable');
  }
  if (amount < 0) { amount = 0; flags.push('amount_negative'); }
  if (amount > AMOUNT_HARD_MAX) {
    fatal = 'amount_absurd';
    flags.push('amount_absurd');
    amount = 0;
  } else if (amount > AMOUNT_REVIEW_THRESHOLD) {
    flags.push('amount_high');
  }
  amount = Math.round(amount * 100) / 100;   // money, not floats

  // ── phone / email ─────────────────────────────────────────────────────────
  const phone = cleanPhone(parsed.customer_phone);
  if (parsed.customer_phone && !phone) flags.push('phone_invalid');
  const email = cleanEmail(parsed.customer_email);
  if (parsed.customer_email && !email) flags.push('email_invalid');

  // ── text fields ───────────────────────────────────────────────────────────
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const name = str(parsed.customer_name, 120) || 'Unknown';
  const address = str(parsed.address, 300);

  let description = str(parsed.professional_description, MAX_DESCRIPTION_CHARS);
  if (!description) { description = str(rawBody, MAX_DESCRIPTION_CHARS); flags.push('description_empty'); }

  // ── enums and confidence ──────────────────────────────────────────────────
  const jobType = JOB_TYPES.includes(parsed.job_type) ? parsed.job_type : 'other';
  if (parsed.job_type && !JOB_TYPES.includes(parsed.job_type)) flags.push('job_type_unknown');

  let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
  if (confidence !== null && (confidence < 0 || confidence > 1)) confidence = null;
  if (confidence !== null && confidence < MIN_CONFIDENCE) flags.push('low_confidence');

  // Anything flagged here is still saved, but must not be auto-sent to a
  // customer without the contractor seeing it first.
  const needsReview = flags.some(f =>
    ['amount_high', 'amount_absurd', 'amount_unparseable', 'low_confidence', 'not_an_object'].includes(f));

  return {
    clean: {
      customer_name:  name,
      customer_phone: phone,
      customer_email: email,
      address,
      amount,
      professional_description: description,
      job_type: jobType,
      confidence,
    },
    flags,
    needsReview,
    fatal,
  };
}

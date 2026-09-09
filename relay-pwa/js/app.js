'use strict';

// ── FIREBASE SDK GUARD ────────────────────────────────────────────────────
// If Firebase CDN fails to load, show a friendly error instead of blank page

if (typeof firebase === 'undefined') {
  document.getElementById('app').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100vh;padding:32px;text-align:center;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
      <div style="width:54px;height:54px;background:#1a2f5e;border-radius:14px;
                  display:flex;align-items:center;justify-content:center;margin-bottom:20px;">
        <span style="color:#fff;font-size:22px;font-weight:800">R</span>
      </div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:8px">Connection error</div>
      <div style="font-size:14px;color:#6b7280;line-height:1.6;margin-bottom:24px;max-width:280px">
        Relay couldn't connect to its servers. Check your internet connection and try again.
      </div>
      <button onclick="location.reload()"
              style="padding:12px 24px;background:#1a2f5e;color:#fff;border:none;
                     border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">
        Retry →
      </button>
    </div>`;
  throw new Error('Firebase SDK not loaded — CDN may be blocked or offline.');
}

// ── FIREBASE ──────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: "AIzaSyAG6yO3waIb6MvdQPZDIGWu_hC8yo5Tfw8",
  authDomain: "relay-portal-68417.firebaseapp.com",
  projectId: "relay-portal-68417",
  storageBucket: "relay-portal-68417.firebasestorage.app",
  messagingSenderId: "171869808653",
  appId: "1:171869808653:web:312170791ff12180e30d44"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

const ADMIN_EMAIL = 'pryorpropertysolutions269@gmail.com';

// ── STRIPE PAYMENT LINKS ──────────────────────────────────────────────────
// Replace these with your real links from stripe.com/payment-links
// Starter plan removed — two tiers only: Essential ($49) and Pro ($99)
const STRIPE_ESSENTIAL = 'https://buy.stripe.com/00w4gB79K9CsaW59LG6g802'; // $49/mo Essential+
const STRIPE_PRO       = 'https://buy.stripe.com/6oU6oJdy82a0aW59LG6g800'; // $99/mo RelayPRO
const STRIPE_BILLING   = 'https://billing.stripe.com/p/login/6oU6oJdy82a0aW59LG6g800';

// ── ACCOUNTING INTEGRATION OAUTH ─────────────────────────────────────────────
// Register at developer.intuit.com (QuickBooks) and
// accounts.zoho.com/developerconsole (Zoho Books).
// Set redirect URI to: https://portal-relay.com/oauth-callback.html
const INTUIT_CLIENT_ID = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
const ZOHO_CLIENT_ID   = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
const OAUTH_REDIRECT   = 'https://portal-relay.com/oauth-callback.html';

// Plan tier constants — must match stripe-webhook.mjs planFromPriceId()
// PLAN_STARTER removed — Essential ($49) is the entry paid tier
const PLAN_ESSENTIAL = 'essential'; // $49/mo Essential+ — full SMS dispatch + accounting sync
const PLAN_PRO       = 'pro';       // $99/mo RelayPRO — all Essential features + future advanced

// Feature gate helpers — checked server-side in twilio-sms.mjs AND client-side in portal
function isAdminUser() { return S.user?.email === ADMIN_EMAIL; }
function canSMSDispatch(plan) {
  return isAdminUser() || ['essential','pro'].includes((plan||'').toLowerCase());
}
function canAutoForward(plan) { return isAdminUser() || (plan||'').toLowerCase() === 'pro'; }
function canReviewRequest(plan) { return isAdminUser() || (plan||'').toLowerCase() === 'pro'; }
// What the PLAN allows. Always a real number so the meter can always draw.
function docLimit(plan) {
  return (plan || '').toLowerCase() === 'pro' ? 500 : 250;  // Essential and anything else
}
// Whether this ACCOUNT is exempt from that limit. Kept separate: conflating the
// two made docLimit return Infinity for the admin, and the meter - which needs
// a finite number to draw a bar - silently rendered nothing on the owner's own
// account, the one account guaranteed to be looking at it.
function isDocLimitExempt() { return isAdminUser(); }
// ── Invoice field accessors ──────────────────────────────────────────────────
// Invoices arrive from two places with different field names: the portal form
// writes customer/work/email/phone, the SMS pipeline writes
// customer_name/professional_description/customer_email/customer_phone.
// Reading through these means existing documents of either shape render
// correctly with no migration - which matters, because a contractor should not
// have to wait for a backfill to see the job they just texted in.
function invCustomer(inv)    { return inv?.customer || inv?.customer_name || ''; }
function invWork(inv)        { return inv?.work || inv?.professional_description || ''; }
function invEmail(inv)       { return inv?.email || inv?.customer_email || ''; }
function invPhone(inv)       { return inv?.phone || inv?.customer_phone || ''; }

// ── Phone normalisation ──────────────────────────────────────────────────────
// The contractor's business phone is the ONLY thing that identifies who is
// texting in. Twilio delivers From in E.164 (+16162481977), so what we store
// has to be in that exact shape or the lookup silently fails and the reply is
// "Phone number not registered with Relay" - which looks like a broken product.
//
// toE164 returns '' for anything that cannot be a real US number, so callers
// can treat empty as "not usable" rather than storing junk that never matches.
function toE164(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length > 11 && d.length <= 15) return '+' + d;   // plausible international
  return '';
}
// Last 10 digits. Stored alongside the E.164 value and used as the lookup key,
// so a number saved in one format still matches a number sent in another.
function phoneDigits(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
function formatPhone(raw) {
  const d = phoneDigits(raw);
  return d ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : String(raw || '');
}

// One renderer for the usage meter. It was inline HTML inside the profile
// screen; the dashboard needs the same thing, and two copies of a progress bar
// drift the moment either is touched.
function usageMeter(plan, { compact = false } = {}) {
  const used   = S.docCountThisMonth || 0;
  const limit  = docLimit(plan);
  const exempt = isDocLimitExempt();
  const pct    = Math.min(100, Math.round((used / limit) * 100));
  const left  = Math.max(0, limit - used);
  const ratio = used / limit;
  const bar   = exempt ? '#1d4ed8'
              : ratio >= 1 ? '#ef4444'
              : ratio > 0.85 ? '#f59e0b'
              : '#1d4ed8';
  const resets = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin-bottom:${compact ? '4' : '14'}px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:12px;font-weight:600;color:#374151">Documents this month</span>
      <span style="font-size:12px;color:#6b7280">${used}${exempt ? '' : ` / ${limit}`}</span>
    </div>
    <div style="height:6px;background:#e5e7eb;border-radius:99px;overflow:hidden">
      <div style="height:100%;width:${pct}%;background:${bar};border-radius:99px;transition:width .3s"></div>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:5px">
      ${exempt
        ? 'Unlimited on this account'
        : left === 0 ? 'Limit reached — upgrade to keep dispatching' : `${left} remaining`} · resets ${resets}
    </div>
  </div>`;
}

function getMonthKey() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
// Every counter is per user by construction: it lives at
// users/{uid}/docCounts/{YYYY-MM}, the security rules allow read and write only
// to that uid, and the limit is read from that user's own plan. One customer's
// usage can never touch another's, and the rules forbid moving a count
// backwards or deleting it, so nobody can reset their own month to zero.
//
// This was a read-then-write, so two tabs could both read 249 and both write
// 250, letting a contractor past the ceiling. A transaction makes the check and
// the increment one atomic step, matching what twilio-sms does on the SMS side.
async function checkAndIncrementDocCount(uid, plan) {
  if (isAdminUser()) return; // admin unlimited
  const ref   = db.collection('users').doc(uid).collection('docCounts').doc(getMonthKey());
  const limit = docLimit(plan);

  await db.runTransaction(async tx => {
    const snap  = await tx.get(ref);
    const count = snap.exists ? (snap.data().count || 0) : 0;
    if (count >= limit) throw Object.assign(new Error('DOC_LIMIT_REACHED'), { limit, count });
    tx.set(ref, {
      count:     count + 1,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

// True when this account has spent its monthly allowance.
function atDocLimit(plan) {
  if (isDocLimitExempt()) return false;
  return (S.docCountThisMonth || 0) >= docLimit(plan);
}
// Protected screens — require active subscription
const PROTECTED = new Set(['dashboard','submit','invoices','customers','profile','addCustomer','editCustomer','invoice']);

// ── STATE ─────────────────────────────────────────────────────────────────

const S = {
  screen:   'loading',
  filter:   'all',
  search:   '',
  formType: 'invoice',
  formPrice:'flat',
  lastJob:  null,
  editCxId: null,      // docId of the customer open on the editCustomer screen
  openInvId: null,     // docId of the invoice open on the invoice screen
  selectMode: false,   // invoice list is in multi-select mode
  selectedInvs: [],    // docIds ticked for deletion
  user:     null,
  profile:  null,
  invoices: [],
  customers:[],
  queue:    [],
};

// ── SVG ICONS ─────────────────────────────────────────────────────────────

const I = {
  home:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  plus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  file:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  users:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  settings:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  back:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  send:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  ext:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  shield:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  camera:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  msg:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  google:`<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
  card:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  phone:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.56 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.49a16 16 0 0 0 6 6l.87-.87a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  logout:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
};

// ── HELPERS ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const fmt = n => '$' + Number(n).toLocaleString();

const AVATAR_COLORS = [
  {bg:'#dbeafe',fg:'#1e40af'},{bg:'#fee2e2',fg:'#991b1b'},{bg:'#dcfce7',fg:'#166534'},
  {bg:'#ede9fe',fg:'#5b21b6'},{bg:'#fef3c7',fg:'#92400e'},{bg:'#fce7f3',fg:'#9d174d'},
];

function getInitials(name='') {
  return ((name.match(/\b\w/g)||['?']).join('').slice(0,2).toUpperCase());
}

function avatarColor(name='') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xFFFF;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

// Plan names arrive from Firestore in whatever case was written - Stripe's
// webhook stores 'pro', older records hold 'Starter' - so interpolating the raw
// value produced "pro Plan · Active" in the top bar. Never print a stored plan
// value directly; print its label.
const PLAN_LABELS = { pro: 'Pro', essential: 'Essential', starter: 'Starter' };
function planLabel(plan) {
  const p = (plan || '').toLowerCase();
  return PLAN_LABELS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Essential');
}

// The top bar said "· Active" unconditionally, so a contractor on a free trial
// or with a failed payment was told their plan was active when it was not.
const SUB_LABELS = {
  active:   'Active',
  trialing: 'Free Trial',
  past_due: 'Payment Due',
  canceled: 'Canceled',
  unpaid:   'Inactive',
};
function subLabel(status) {
  const t = (status || '').toLowerCase();
  return SUB_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : 'Inactive');
}

// ── Onboarding readiness ─────────────────────────────────────────────────────
//
// An account needs four things before Relay works end to end. Miss any one and
// the product half-works SILENTLY - which is exactly how a trial dies without
// anyone complaining: no phone number and texting replies "not registered"; no
// accounting connection and invoices never leave Relay; no review link and Pro's
// headline feature does nothing at all.
//
// Each step says what breaks if it is skipped, not just what to do. A checklist
// that only lists tasks gets ignored; one that names the consequence gets done.
function onboardingSteps() {
  const p    = S.profile || {};
  const plan = (p.plan || '').toLowerCase();
  const sub  = p.subscriptionStatus || 'unpaid';

  const steps = [
    {
      key:  'phone',
      done: !!p.phoneNumber,
      label: 'Add your business phone number',
      why:  'Relay identifies your jobs by the number you text from. Without it, texting replies "not registered".',
      nav:  'profile',
    },
    {
      key:  'plan',
      done: ['active', 'trialing'].includes(sub),
      label: 'Activate your plan',
      why:  'Dispatch stays locked until a plan is active.',
      nav:  'profile',
    },
    {
      key:  'accounting',
      done: !!(p.accountingProvider && p.accountingProvider !== 'none'),
      label: 'Connect QuickBooks or Zoho Books',
      why:  'Without it, invoices stay inside Relay and never reach your books.',
      nav:  'profile',
    },
  ];

  // Review follow-up is a RelayPRO feature, so the review link is only a
  // required step for accounts that actually have it.
  if (canReviewRequest(plan)) {
    steps.push({
      key:  'review',
      done: !!p.reviewUrl,
      label: 'Add your review link',
      why:  'Review follow-up has nowhere to send customers until this is set.',
      nav:  'profile',
    });
  }

  return steps;
}

function badge(status) {
  // 'needs_review' is set by the SMS parse guard when the model's output looked
  // implausible. It reuses the overdue styling because it needs the same
  // attention; there is no dedicated CSS class for it.
  const map = {paid:'paid',sent:'sent',overdue:'overdue',quote:'quote',pending:'pending',needs_review:'overdue'};
  const lbl = {paid:'Paid',sent:'Sent',overdue:'Overdue',quote:'Quote',pending:'Pending',needs_review:'Needs Review'};
  return `<span class="badge ${map[status]||''}">${lbl[status]||status}</span>`;
}

function platBadge(p) {
  return p === 'quickbooks'
    ? `<span class="badge qb">QuickBooks</span>`
    : p === 'zoho'
    ? `<span class="badge zoho">Zoho Books</span>`
    : `<span class="badge pending">No platform</span>`;
}

function qbUrl(id)   { return `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(id)}`; }
function zohoUrl(id) { return `https://books.zoho.com/app#invoices/${encodeURIComponent(id)}`; }

function friendlyAuthError(code) {
  const map = {
    'auth/wrong-password':       'Incorrect password. Please try again.',
    'auth/invalid-credential':   'Incorrect email or password.',
    'auth/user-not-found':       'No account found with that email.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password':        'Password must be at least 6 characters.',
    'auth/invalid-email':        'Please enter a valid email address.',
    'auth/too-many-requests':    'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user': 'Google sign-in was canceled.',
    'auth/network-request-failed': 'Network error — check your connection.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

function showErr(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function setBtn(id, loading, label) {
  const el = $(id);
  if (!el) return;
  el.disabled = loading;
  el.textContent = loading ? 'Please wait…' : label;
}

// ── FIREBASE DATA ─────────────────────────────────────────────────────────

async function loadUserData(uid) {
  try {
    const monthKey = getMonthKey();
    // allSettled, not all: one failing read must not take the others down with
    // it. A missing security rule on docCounts once rejected this whole batch,
    // so the catch fell back to plan:'unpaid' and locked every signed-in user
    // out of a paid account. Degrade per-source instead.
    const [profRes, invRes, cxRes, dcRes] = await Promise.allSettled([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('invoices').get(),
      db.collection('users').doc(uid).collection('customers').get(),
      db.collection('users').doc(uid).collection('docCounts').doc(monthKey).get(),
    ]);
    for (const [label, res] of [['profile', profRes], ['invoices', invRes],
                                ['customers', cxRes], ['docCounts', dcRes]]) {
      if (res.status === 'rejected') console.error(`loadUserData: ${label} failed:`, res.reason);
    }
    if (profRes.status === 'rejected') throw profRes.reason;   // profile is load-bearing
    const profSnap = profRes.value;
    const invSnap  = invRes.status === 'fulfilled' ? invRes.value : { docs: [] };
    const cxSnap   = cxRes.status  === 'fulfilled' ? cxRes.value  : { docs: [] };
    const dcSnap   = dcRes.status  === 'fulfilled' ? dcRes.value  : { exists: false };

    S.profile = profSnap.exists ? profSnap.data() : {
      companyName: S.user.displayName || 'My Company',
      plan: 'unpaid',
      platform: 'none',
      laborRate: 100,
      materialMarkup: 15,
      paymentTerms: 'Due on receipt',
    };

    // Admin always gets pro regardless of Firestore plan field
    if (S.user?.email === ADMIN_EMAIL) {
      S.profile = {
        ...S.profile,
        plan: 'pro',
        subscriptionStatus: 'active',
        autoForwardToCustomer: S.profile?.autoForwardToCustomer ?? false,
        reviewUrl: S.profile?.reviewUrl || '',
      };
    }

    S.invoices = invSnap.docs
      .map(d => ({docId: d.id, ...d.data()}))
      // Soft-deleted documents remain in Firestore but never appear in the UI.
      .filter(i => !i.deleted)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    S.customers = cxSnap.docs.map(d => ({docId: d.id, ...d.data()}));
    S.docCountThisMonth = dcSnap.exists ? (dcSnap.data().count || 0) : 0;

    // Backfill. Accounts created before this existed stored only `phone`, a
    // field no function reads, so they could never text in. If a usable number
    // is already on file, promote it to the canonical fields silently rather
    // than making the contractor re-enter something they already gave us.
    if (S.profile && !S.profile.phoneNumber && S.profile.phone) {
      const e164 = toE164(S.profile.phone);
      if (e164) {
        const patch = { phoneNumber: e164, phoneDigits: phoneDigits(e164) };
        S.profile = { ...S.profile, ...patch };
        db.collection('users').doc(uid).update(patch)
          .then(() => console.log('[backfill] promoted phone -> phoneNumber'))
          .catch(e => console.error('[backfill] failed:', e.message));
      }
    }
  } catch(e) {
    console.error('loadUserData:', e);
    if (!S.profile) S.profile = {companyName: 'My Company', plan: 'unpaid', platform: 'none'};
    S.invoices  = S.invoices  || [];
    S.customers = S.customers || [];
    S.docCountThisMonth = S.docCountThisMonth || 0;
  }
}

async function loadDispatchQueue() {
  try {
    const snap = await db.collection('dispatch').where('status', '==', 'pending').get();
    S.queue = snap.docs
      .map(d => ({docId: d.id, ...d.data()}))
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
  } catch(e) {
    console.error('loadDispatchQueue:', e);
    S.queue = [];
  }
}

// ── COMPONENTS ───────────────────────────────────────────────────────────

function tabs(active) {
  const t = [
    {id:'dashboard', ic:I.home,     lbl:'Home'},
    {id:'submit',    ic:I.plus,     lbl:'New'},   
    {id:'invoices',  ic:I.file,     lbl:'Logs'},    
    {id:'customers', ic:I.users,    lbl:'Customers'},
  ];
  return `<nav class="tabs">${t.map(x=>`
    <button class="tab${active===x.id?' on':''}" data-nav="${x.id}">${x.ic}${x.lbl}</button>`).join('')}</nav>`;
}

// The settings gear is rendered HERE, by the top bar itself, rather than passed
// in by each screen. Screens that forget to pass it are the reason it was
// reachable from only two pages before; a control that must be everywhere
// cannot depend on fifteen call sites each remembering to include it.
//
// `settings:false` opts out, and only two screens should: the locked screen and
// plan selection, where 'profile' is a PROTECTED screen and tapping the gear
// would bounce the user straight back to the locked screen.
function topbar({title, sub='', back='', light=false, right='', settings=true}) {
  const showGear = settings && !!S.user && S.screen !== 'profile';
  return `<header class="topbar${light?' light':''}">
    ${back
      ? `<button class="back-btn${light?' dark':''}" data-nav="${back}" aria-label="Back">${I.back}</button>`
      : `<div class="topbar-logo">R</div>`}
    <div style="flex:1;min-width:0">
      <div class="topbar-title">${title}</div>
      ${sub ? `<div class="topbar-sub">${sub}</div>` : ''}
    </div>
    <div class="topbar-actions">
      ${right}
      ${showGear ? `<button class="topbar-btn" data-nav="profile" title="Settings" aria-label="Settings">${I.settings}</button>` : ''}
    </div>
  </header>`;
}

// ── SCREENS ───────────────────────────────────────────────────────────────

function sLoading() {
  return `<div class="loading-wrap">
    <div class="relay-mark" style="margin-bottom:24px"><span>R</span></div>
    <div class="spinner"></div>
  </div>`;
}

function sLogin() {
  return `<main class="login-wrap">
    <div class="relay-mark"><span>R</span></div>
    <h1 class="login-title">Welcome to Relay</h1>
    <p class="login-sub">Your dispatch &amp; invoicing portal. Sign in to get started.</p>
    <p class="login-value">Built for contractors who'd rather be on the job.</p>
    <div id="lg-err" class="auth-error" style="display:none"></div>
    <div class="form-group">
      <label class="form-lbl" for="lg-email">Email</label>
      <input id="lg-email" type="email" class="input" placeholder="you@yourbusiness.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-lbl" for="lg-pw">Password</label>
      <input id="lg-pw" type="password" class="input" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button id="lg-btn" class="btn btn-primary" data-action="login" style="margin-bottom:8px">Sign In To Relay</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Continue with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="signup">New To Relay? Create An Account →</button>
    </div>
  </main>`;
}

function sSignup() {
  return `<main class="login-wrap">
    <div class="relay-mark"><span>R</span></div>
    <h1 class="login-title">Create Your Account</h1>
    <p class="login-sub">Join the Relay network. Your portal is ready immediately.</p>
    <div id="sg-err" class="auth-error" style="display:none"></div>
    <div class="form-group">
      <label class="form-lbl" for="sg-co">Company / DBA name <span class="req">*</span></label>
      <input id="sg-co" type="text" class="input" placeholder="e.g. Hartwell Contracting" autocomplete="organization">
    </div>
    <div class="form-group">
      <label class="form-lbl" for="sg-email">Business email <span class="req">*</span></label>
      <input id="sg-email" type="email" class="input" placeholder="you@yourbusiness.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-lbl" for="sg-pw">Password <span class="req">*</span></label>
      <input id="sg-pw" type="password" class="input" placeholder="Min. 6 characters" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label class="form-lbl" for="sg-pw2">Confirm password <span class="req">*</span></label>
      <input id="sg-pw2" type="password" class="input" placeholder="Re-enter password" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label class="form-lbl">Accounting Software</label>
      <select id="sg-platform" class="input">
        <option value="quickbooks">QuickBooks Online</option>
        <option value="zoho">Zoho Books</option>
        <option value="none">I'll set this up later</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-lbl" for="sg-phone">Mobile phone <span class="req">*</span></label>
      <input id="sg-phone" type="tel" class="input" placeholder="(555) 867-5309" autocomplete="tel">
    </div>
    <!-- Carrier-facing SMS consent.
         A toll-free verification reviewer opens the public signup page and
         checks for all of this: an unchecked box, what messages are sent, how
         often, the rates disclaimer, HELP and STOP, and links to the Terms and
         Privacy Policy. The previous copy named none of the message types, gave
         no frequency and no HELP keyword, and linked to nothing - and the box
         was recorded but never enforced, so an account could be created without
         consent and still be texted. Do not shorten this without checking the
         requirement it satisfies. -->
    <label id="sg-consent-box" style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;cursor:pointer;">
      <input id="sg-sms" type="checkbox" style="margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:#6366f1;">
      <span style="font-size:12px;color:#4b5563;line-height:1.6;">
        <strong>Yes, text me at the number above.</strong> I agree to receive SMS from
        Relay (Pryor Digital Ventures LLC) about my account: job confirmations,
        invoice and quote notifications, and account alerts. Message frequency varies by how many jobs you submit —
        typically 5&ndash;20 messages per month. Msg &amp; data rates may apply.
        Reply STOP to unsubscribe or HELP for help.
      </span>
    </label>
    <p style="font-size:11px;color:#9ca3af;line-height:1.6;margin:0 0 16px 26px;">
      By creating an account you agree to our
      <a href="/terms.html" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:underline">Terms of Service</a>
      and
      <a href="/privacy.html" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:underline">Privacy Policy</a>.
      We never sell your information, and consent to receive text messages is
      not a condition of any purchase.
    </p>
    <button id="sg-btn" class="btn btn-primary" data-action="signup" style="margin-bottom:8px">Yes, Create My Relay Account</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Sign up with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="login">Already Have An Account? Sign In →</button>
    </div>
  </main>`;
}

function sLocked(featureName) {
  return topbar({title:'Upgrade Required', settings:false}) +
    `<div class="scroll" style="padding:24px 16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;margin-bottom:12px">🔒</div>
        <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">Unlock ${featureName}</h2>
        <p style="font-size:14px;color:#6b7280">This feature requires an upgraded plan. Choose a plan below to get started.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="plan-card featured">
          <div style="margin-bottom:8px"><span class="badge paid">Most popular</span></div>
          <div class="plan-name">Essential</div>
          <div class="plan-price">$49<span>/mo</span></div>
          <div class="plan-feat">
            <div class="plan-feat-item">${I.check}AI SMS Dispatch — text a job, get an invoice</div>
            <div class="plan-feat-item">${I.check}Up to 250 documents/month</div>
            <div class="plan-feat-item">${I.check}QuickBooks &amp; Zoho Books sync</div>
            <div class="plan-feat-item">${I.check}14-day free trial</div>
          </div>
          <a href="${STRIPE_ESSENTIAL}" target="_blank" rel="noopener"
             class="btn btn-primary" style="margin-top:12px;display:block;text-align:center">
            Start Free Trial
          </a>
        </div>
        <div class="plan-card">
          <div class="plan-name">Relay Pro</div>
          <div class="plan-price">$99<span>/mo</span></div>
          <div class="plan-feat">
            <div class="plan-feat-item">${I.check}Everything in Essential</div>
            <div class="plan-feat-item">${I.check}500 documents/month</div>
            <div class="plan-feat-item">${I.check}Auto-forward docs to customers</div>
            <div class="plan-feat-item">${I.check}Automated review request SMS</div>
          </div>
          <a href="${STRIPE_PRO}" target="_blank" rel="noopener"
             class="btn btn-outline" style="margin-top:12px;display:block;text-align:center">
            Get Pro
          </a>
        </div>
      </div>
      <div style="height:16px"></div>
    </div>`;
}
function sPlans() {
  return topbar({title:'Choose Your Plan', back:'signup', settings:false}) +
    `<div class="scroll">
      <p style="font-size:13px;color:#6b7280;margin-bottom:14px">Billed directly via Stripe — no app store cut. Cancel anytime.</p>
      <div class="plan-card featured">
        <div style="margin-bottom:8px"><span class="badge paid">Most popular</span></div>
        <div class="plan-name">Essential</div>
        <div class="plan-price">$49<span>/mo</span></div>
        <div class="plan-feat">
          <div class="plan-feat-item">${I.check}AI SMS Dispatch — text a job, get an invoice</div>
          <div class="plan-feat-item">${I.check}Invoice creation and tracking</div>
          <div class="plan-feat-item">${I.check}Customer registry &amp; portal</div>
          <div class="plan-feat-item">${I.check}Connect QuickBooks or Zoho — no double entry ever</div>
          <div class="plan-feat-item">${I.check}14-day free trial included</div>
        </div>
        <a href="${STRIPE_ESSENTIAL}" target="_blank" rel="noopener" class="btn btn-primary" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Start Free Trial</a>
      </div>
      <div class="plan-card">
        <div class="plan-name">Relay Pro</div>
        <div class="plan-price">$99<span>/mo</span></div>
        <div class="plan-feat">
          <div class="plan-feat-item">${I.check}Everything in Essential+</div>
          <div class="plan-feat-item">${I.check}Full AI automation — proposals, dispatch &amp; follow-ups</div>
          <div class="plan-feat-item">${I.check}Multi-user access &amp; advanced reporting</div>
          <div class="plan-feat-item">${I.check}14-day free trial included</div>
        </div>
        <a href="${STRIPE_PRO}" target="_blank" rel="noopener" class="btn btn-outline" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Start Free Trial</a>
      </div>
      <div style="height:16px"></div>
    </div>`;
}
function sDashboard() {
  const name    = S.profile?.companyName || 'My Company';
  const plan    = S.profile?.plan        || 'Essential';
  const invs    = S.invoices || [];
  const recent  = invs.slice(0, 3);
  const isAdmin = S.user?.email === ADMIN_EMAIL;
  const subStatus = S.profile?.subscriptionStatus || 'unpaid';

  const trialBanner = (!isAdmin && subStatus === 'trialing') ? `
    <div class="trial-banner">
      <span style="font-size:18px">⏳</span>
      <div style="flex:1">
        <div class="trial-banner-title">Your 14-day free trial is active</div>
        <div class="trial-banner-sub">Your card will be charged automatically when the trial ends. Cancel any time before then — no charge.</div>
      </div>
      <a href="${STRIPE_BILLING}" target="_blank" rel="noopener" class="trial-banner-btn">Manage trial →</a>
    </div>` : '';

  const pastDueBanner = (!isAdmin && subStatus === 'past_due') ? `
    <div class="past-due-banner">
      <span style="font-size:20px">⚠️</span>
      <div style="flex:1">
        <div class="past-due-banner-title">⚠️ ACTION REQUIRED — Payment Past Due</div>
        <div class="past-due-banner-sub">Update your payment method within 7 days or your portal access will be suspended. Your data is safe.</div>
      </div>
      <a href="${STRIPE_BILLING}" target="_blank" rel="noopener" class="past-due-banner-btn">Update Payment →</a>
    </div>` : '';

  // Without a stored business phone, texting a job returns "not registered".
  // That reads as a broken product, so it is surfaced as loudly as a billing
  // problem rather than left for the contractor to discover from a roof.
  const noPhoneBanner = (!S.profile?.phoneNumber && canSMSDispatch(plan)) ? `
    <div class="past-due-banner">
      <span style="font-size:20px">\u{1F4F1}</span>
      <div style="flex:1">
        <div class="past-due-banner-title">Add your business phone number</div>
        <div class="past-due-banner-sub">Relay identifies your job texts by the number you send them from. Until it is saved, texting (844) 729-1376 replies &ldquo;not registered&rdquo; and no invoice is created.</div>
      </div>
      <span data-nav="profile" class="past-due-banner-btn" style="cursor:pointer">Add it \u2192</span>
    </div>` : '';

  // Setup checklist. Disappears for good once every step is done, so an
  // established account never sees it. The phone banner above stays as well -
  // it is the one failure a contractor hits from a roof, and it earns the
  // duplication.
  const steps    = isAdmin ? [] : onboardingSteps();
  const doneCt   = steps.filter(x => x.done).length;
  const setupCard = (steps.length && doneCt < steps.length) ? `
    <div class="card" style="padding:16px;margin-bottom:12px;border-left:3px solid #6366f1">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px">
        <div style="font-weight:700;font-size:15px">Finish setting up Relay</div>
        <div style="font-size:12px;color:#6b7280;font-variant-numeric:tabular-nums">${doneCt} of ${steps.length}</div>
      </div>
      <div style="font-size:12px;color:#6b7280;line-height:1.5;margin-bottom:12px">
        Relay works end to end once these are done. Until then, parts of it stay quiet.
      </div>
      <div style="height:5px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${Math.round((doneCt / steps.length) * 100)}%;background:#6366f1;border-radius:99px;transition:width .3s"></div>
      </div>
      ${steps.map(st => `
        <div ${st.done ? '' : `data-nav="${st.nav}" style="cursor:pointer"`}
             style="display:flex;gap:11px;align-items:flex-start;padding:9px 0;border-top:1px solid #f3f4f6${st.done ? '' : ';cursor:pointer'}">
          <div style="width:20px;height:20px;border-radius:50%;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
                      background:${st.done ? '#059669' : '#e5e7eb'};color:${st.done ? '#fff' : '#9ca3af'}">
            ${st.done ? '&#x2713;' : ''}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:${st.done ? '#9ca3af' : '#111827'};${st.done ? 'text-decoration:line-through' : ''}">
              ${st.label}
            </div>
            ${st.done ? '' : `<div style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:2px">${st.why}</div>`}
          </div>
          ${st.done ? '' : '<span style="color:#6366f1;font-size:18px;line-height:1;flex-shrink:0">&rsaquo;</span>'}
        </div>`).join('')}
    </div>` : '';

  return topbar({title: name, sub: `${planLabel(plan)} Plan · ${subLabel(subStatus)}`, right:
    isAdmin ? `<button class="topbar-btn" data-action="goAdmin" title="Admin" aria-label="Admin">${I.shield}</button>` : ''
  }) +
  `<div class="scroll">${noPhoneBanner}${trialBanner}${pastDueBanner}${setupCard}

    <div style="margin-bottom:4px">
      <svg viewBox="0 0 390 298" xmlns="http://www.w3.org/2000/svg" style="width:100%;border-radius:18px;display:block">
        <defs>
          <linearGradient id="dbg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#2d1b4e"/><stop offset="100%" style="stop-color:#6d28d9"/></linearGradient>
          <linearGradient id="s1g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#34d399"/><stop offset="100%" style="stop-color:#10b981"/></linearGradient>
          <linearGradient id="s2g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#fbbf24"/><stop offset="100%" style="stop-color:#f59e0b"/></linearGradient>
          <linearGradient id="s3g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#9333ea"/></linearGradient>
          <linearGradient id="wg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:rgba(255,255,255,0.07)"/><stop offset="100%" style="stop-color:rgba(255,255,255,0.03)"/></linearGradient>
          <filter id="dgl"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <rect width="390" height="298" rx="20" fill="url(#dbg)"/>
        <circle cx="330" cy="25" r="70" fill="rgba(255,255,255,0.03)"/>
        <circle cx="370" cy="80" r="45" fill="rgba(255,255,255,0.025)"/>
        <text x="374" y="19" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10.5" font-weight="700" fill="rgba(255,255,255,0.28)" text-anchor="end">Relay</text>
        <polygon points="22,10 17,24 21,24 16,38 24,21 20,21" fill="rgba(192,132,252,0.55)"/>
        <circle cx="38" cy="44" r="22" fill="rgba(255,255,255,0.11)"/>
        <rect x="27" y="35" width="22" height="16" rx="4" fill="none" stroke="white" stroke-width="1.6"/>
        <line x1="31" y1="40" x2="45" y2="40" stroke="white" stroke-width="1.3" stroke-linecap="round" opacity="0.75"/>
        <line x1="31" y1="44" x2="41" y2="44" stroke="white" stroke-width="1.3" stroke-linecap="round" opacity="0.75"/>
        <path d="M30 51 l4-4" stroke="white" stroke-width="1.4" stroke-linecap="round" opacity="0.75"/>
        <text x="70" y="38" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="22" font-weight="800" fill="white" letter-spacing="0.3">1 (844) 729-1376</text>
        <text x="70" y="51" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="9.5" font-weight="600" fill="rgba(255,255,255,0.52)" letter-spacing="1.4">SMS DISPATCH LINE</text>
        <text x="70" y="66" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" font-weight="700" fill="rgba(255,255,255,0.9)">How to Submit a Job via Text:</text>
        <line x1="18" y1="80" x2="372" y2="80" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
        <circle cx="183" cy="80" r="2.5" fill="rgba(255,255,255,0.28)"/><circle cx="193" cy="80" r="2.5" fill="rgba(255,255,255,0.28)"/><circle cx="203" cy="80" r="2.5" fill="rgba(255,255,255,0.28)"/>
        <circle cx="36" cy="108" r="15" fill="url(#s1g)" filter="url(#dgl)" opacity="0.92"/>
        <text x="36" y="113" font-family="-apple-system,sans-serif" font-size="13" font-weight="800" fill="white" text-anchor="middle">1</text>
        <circle cx="360" cy="103" r="5.5" fill="none" stroke="rgba(52,211,153,0.48)" stroke-width="1.3"/>
        <path d="M352 116 q8-5 16 0" fill="none" stroke="rgba(52,211,153,0.48)" stroke-width="1.3" stroke-linecap="round"/>
        <line x1="36" y1="123" x2="36" y2="143" stroke="rgba(52,211,153,0.38)" stroke-width="1.5" stroke-dasharray="3,3"/>
        <text x="62" y="103" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13.5" font-weight="700" fill="white">Customer Name, Address &amp; Phone</text>
        <text x="62" y="118" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" fill="rgba(255,255,255,0.52)">Full service address and best contact number</text>
        <circle cx="36" cy="156" r="15" fill="url(#s2g)" filter="url(#dgl)" opacity="0.92"/>
        <text x="36" y="161" font-family="-apple-system,sans-serif" font-size="13" font-weight="800" fill="white" text-anchor="middle">2</text>
        <rect x="351" y="148" width="14" height="14" rx="2" fill="none" stroke="rgba(245,158,11,0.48)" stroke-width="1.3"/>
        <line x1="354" y1="153" x2="362" y2="153" stroke="rgba(245,158,11,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="354" y1="156" x2="362" y2="156" stroke="rgba(245,158,11,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="354" y1="159" x2="359" y2="159" stroke="rgba(245,158,11,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="36" y1="171" x2="36" y2="191" stroke="rgba(245,158,11,0.38)" stroke-width="1.5" stroke-dasharray="3,3"/>
        <text x="62" y="151" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13.5" font-weight="700" fill="white">Description of Work Done or Quoted</text>
        <text x="62" y="166" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" fill="rgba(255,255,255,0.52)">Short summary of the job or estimate provided</text>
        <circle cx="36" cy="204" r="15" fill="url(#s3g)" filter="url(#dgl)" opacity="0.92"/>
        <text x="36" y="209" font-family="-apple-system,sans-serif" font-size="13" font-weight="800" fill="white" text-anchor="middle">3</text>
        <circle cx="358" cy="200" r="8" fill="none" stroke="rgba(192,132,252,0.48)" stroke-width="1.3"/>
        <text x="358" y="204.5" font-family="-apple-system,sans-serif" font-size="10" font-weight="700" fill="rgba(192,132,252,0.65)" text-anchor="middle">$</text>
        <text x="62" y="199" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13.5" font-weight="700" fill="white">Amount to be Charged for Service $</text>
        <text x="62" y="214" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" fill="rgba(255,255,255,0.52)">Total dollar amount for the invoice or quote</text>
        <rect x="14" y="228" width="362" height="58" rx="10" fill="url(#wg)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <text x="28" y="249" font-family="-apple-system,sans-serif" font-size="13" fill="rgba(255,255,255,0.7)">&#x26A0;</text>
        <text x="44" y="248" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10.5" fill="rgba(255,255,255,0.85)"><tspan font-weight="800" fill="white">*IMPORTANT!:</tspan><tspan> All three fields </tspan><tspan font-weight="800" text-decoration="underline" fill="white">MUST</tspan><tspan> be included in every text</tspan></text>
        <text x="44" y="261" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10.5" fill="rgba(255,255,255,0.85)">message to ensure a complete and accurate submission.</text>
        <text x="28" y="276" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10" fill="rgba(255,255,255,0.42)">*Missing details may result in an incomplete or failed document.</text>
      </svg>
    </div>
    <div style="margin-top:14px">${usageMeter(plan, { compact: true })}</div>
    <p class="sh" style="margin-top:20px">Recent Activity</p>
    <div class="card">
      ${recent.length
        ? recent.map(inv => {
            const ac  = avatarColor(inv.customer || '');
            return `<div class="act-item">
              <div class="inv-av" style="background:${ac.bg};color:${ac.fg};width:36px;height:36px;font-size:12px;flex-shrink:0">
                ${getInitials(inv.customer||'?')}
              </div>
              <div style="flex:1;min-width:0">
                <div class="act-title">${inv.customer || 'Unknown'}</div>
                <div class="act-sub">${fmtDate(inv.createdAt)} · ${fmt(inv.amount||0)} · ${(inv.type||'invoice').charAt(0).toUpperCase()+(inv.type||'invoice').slice(1)}</div>
              </div>
              <div style="flex-shrink:0">${badge(inv.status)}</div>
            </div>`;
          }).join('')
        : `<div style="padding:32px 20px;text-align:center">
            <div style="width:52px;height:52px;background:#f3f4f6;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:#9ca3af">${I.send}</div>
            <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:6px">No jobs yet</div>
            <div style="font-size:13px;color:#9ca3af">Text your first job to the dispatch line above to get started.</div>
          </div>`
      }
    </div>
  </div>
  ${tabs('dashboard')}`;
}

function sSubmit() {
  const plan = (S.profile?.plan || 'unpaid').toLowerCase();

  // Being told the allowance is gone only after filling in the whole form and
  // pressing Send is a bad way to find out. The cut-off is stated before any
  // typing, and the submit control is genuinely gone rather than left there to
  // be pressed and rejected.
  if (atDocLimit(plan)) {
    return topbar({title: 'New Job Submission', back: 'dashboard'}) +
    `<div class="scroll">
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:22px 20px;text-align:center;margin-top:8px">
        <div style="font-size:34px;line-height:1;margin-bottom:12px">&#x1F4E6;</div>
        <div style="font-size:17px;font-weight:700;color:#991b1b;margin-bottom:8px">
          You've used all ${docLimit(plan)} documents this month
        </div>
        <p style="font-size:13px;color:#7f1d1d;line-height:1.6;margin-bottom:18px">
          Your allowance resets on
          ${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.
          Upgrade to keep dispatching now &mdash; everything already created stays exactly where it is.
        </p>
        <button class="btn btn-primary" data-nav="profile" style="margin-bottom:0">Upgrade My Plan</button>
      </div>
      <div style="height:20px"></div>
    </div>
    ${tabs('submit')}`;
  }

  return topbar({title: 'New Job Submission', back: 'dashboard'}) +
  `<div class="scroll">
    <p class="sh">Job Type <span class="req">*</span></p>
    <div class="toggle-g">
      <button class="toggle-btn${S.formType==='invoice'?' on':''}" data-toggle="type" data-val="invoice">${I.file} Invoice</button>
      <button class="toggle-btn${S.formType==='quote'?' on':''}" data-toggle="type" data-val="quote">${I.file} Quote</button>
    </div>
    <p class="sh">Customer Info</p>
    <div class="form-group"><label class="form-lbl" for="f-name">Customer name <span class="req">*</span></label><input id="f-name" type="text" class="input" placeholder="e.g. Jeff Smith" autocomplete="off"></div>
    <div class="form-group"><label class="form-lbl" for="f-phone">Customer's Phone Number <span class="req">*</span></label><input id="f-phone" type="tel" class="input" placeholder="(616) 248-1977"></div>
    <div class="form-group"><label class="form-lbl" for="f-email">Customer email</label><input id="f-email" type="email" class="input" placeholder="Optional for document delivery"></div>
    <p class="sh">Job Details</p>
    <div class="form-group"><label class="form-lbl" for="f-addr">Job address <span class="req">*</span></label><input id="f-addr" type="text" class="input" placeholder="412 Oak St, Grand Rapids MI" autocomplete="off"></div>
    <div class="form-group"><label class="form-lbl" for="f-work">Work description <span class="req">Describe what was done in two to four sentences. Provide any critical detail needed.</span></label><textarea id="f-work" class="input" placeholder="Describe what was done in 2–3 sentences.&#10;e.g. Removed and replaced water heater, installed new supply valve."></textarea></div>
    <div class="form-group"><label class="form-lbl" for="f-poref">PO / Job Ref Number</label><input id="f-poref" type="text" class="input" placeholder="Optional — for property managers or commercial accounts"></div>
    <p class="sh">Pricing</p>
    <div class="toggle-g">
      <button class="toggle-btn${S.formPrice==='flat'?' on':''}" data-toggle="price" data-val="flat">Flat Rate</button>
      <button class="toggle-btn${S.formPrice==='itemized'?' on':''}" data-toggle="price" data-val="itemized">Materials + Labor</button>
    </div>
    ${S.formPrice === 'flat'
      ? `<div class="form-group"><label class="form-lbl" for="f-total">Total amount <span class="req">*</span></label><input id="f-total" type="text" class="input" placeholder="$0.00"></div>`
      : `<div class="input-row">
          <div class="form-group"><label class="form-lbl" for="f-mat">Materials</label><input id="f-mat" type="text" class="input" placeholder="$0.00"></div>
          <div class="form-group"><label class="form-lbl" for="f-lab">Labor</label><input id="f-lab" type="text" class="input" placeholder="3 hrs @ $100"></div>
        </div>`}
    ${S.formType === 'quote' ? `<div class="form-group"><label class="form-lbl" for="f-deposit">Deposit Required</label><input id="f-deposit" type="text" class="input" placeholder="e.g. 50% due to schedule, or $200"></div>` : ''}
    <div class="form-group"><label class="form-lbl" for="f-warranty">Warranty / Guarantee Period</label><input id="f-warranty" type="text" class="input" placeholder="e.g. 90 days on labor and parts"></div>
    <div class="form-group"><label class="form-lbl" for="f-notes">Special Notes</label><input id="f-notes" type="text" class="input" placeholder="e.g. Address invoice to property manager"></div>
    <!-- Document Template File -->
    <div class="form-group">
      <label class="form-lbl">Document Template File</label>
      <span class="form-hint">Upload a blank template or example document. Relay will use this as the format when generating documents for each customer.</span>
      <div class="template-upload-wrap">
        <input type="file" id="f-template" accept=".pdf,.doc,.docx" class="form-input" onchange="handleTemplateUpload(this)">
        <p class="template-hint" id="f-template-status"></p>
      </div>
    </div>
    <div id="sub-err" class="auth-error" style="display:none;margin-bottom:10px"></div>
    <button id="sub-btn" class="btn btn-primary" data-action="submitJob">Send To Relay Dispatch</button>
    <div style="height:20px"></div>
  </div>
  ${tabs('submit')}`;
}

function sConfirm() {
  const j = S.lastJob || {type:'invoice', customer:'Customer', amount:'$0'};
  return `<div class="confirm-wrap">
    <div class="confirm-icon">${I.check}</div>
    <h2 class="confirm-title">Job Submitted!</h2>
    <p class="confirm-sub">Relay is processing your ${j.type}. Your customer will receive it by email and text shortly.</p>
    <div class="confirm-card">
      <div style="font-size:11px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px">${j.type} · ${j.customer}</div>
      <div style="font-size:28px;font-weight:700;color:#111827">${j.amount}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:8px;line-height:1.7">
        Sent to Relay dispatch ✓<br>
        Auto-reminder after 72 hrs if unpaid ✓<br>
        Google review request sent after payment ✓
      </div>
    </div>
    ${j.docId ? `<button class="btn btn-outline" onclick="(function(){navigator.clipboard.writeText('https://portal-relay.com/doc/'+j.docId);this.textContent='✓ Link Copied!';setTimeout(()=>this.textContent='📋 Copy Customer Link',2000)}).call(this)" style="margin-bottom:10px">📋 Copy Customer Link</button>` : ''}
    <button class="btn btn-primary" data-nav="dashboard" style="margin-bottom:10px">Back To Dashboard</button>
    <button class="btn btn-outline" data-nav="submit">Submit Another Job</button>
  </div>`;
}

function sInvoices() {
  const invs    = S.invoices || [];
  const filters = ['all','needs_review','pending','sent','overdue','paid','quote'];
  const list    = S.filter === 'all' ? invs : invs.filter(i => i.status === S.filter);

  // Select / Cancel lives in the topbar, where a screen-level mode toggle
  // belongs - not wedged into the horizontally scrolling filter row, where it
  // pushed the chips sideways and scrolled out of reach.
  const nSel     = S.selectedInvs.length;
  const allPicked = list.length > 0 && list.every(i => S.selectedInvs.includes(i.docId));

  return topbar({
    title: 'Invoices',
    sub:   S.selectMode ? `${nSel} of ${list.length} selected` : `${invs.length} total`,
    right: S.selectMode
      ? `<button class="sel-link" data-action="cancelSelect">Cancel</button>`
      : `<button class="sel-link" data-action="startSelect">Select</button>`,
  }) +
  `${S.selectMode ? `
    <div class="sel-bar">
      <span class="sel-count">${nSel ? `${nSel} selected` : 'Select documents to delete'}</span>
      <div class="sel-actions">
        <button class="sel-btn" data-action="selectAllInvs" ${list.length ? '' : 'disabled'}>
          ${allPicked ? 'Clear all' : 'Select all'}
        </button>
        <button class="sel-btn sel-btn-danger" data-action="deleteSelected" ${nSel ? '' : 'disabled'}>
          ${nSel ? `Delete (${nSel})` : 'Delete'}
        </button>
      </div>
    </div>
    <div id="inv-del-err" class="auth-error" style="display:none;margin:10px 16px 0"></div>` : ''}
  <div class="filter-row">
    ${filters.map(f=>`<button class="fp${S.filter===f?' on':''}" data-filter="${f}">${f==='needs_review'?'Needs Review':f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
  </div>
  <div class="scroll" style="padding:12px 16px">
    <div class="card">
      ${list.length
        ? list.map(inv => {
            const cust = invCustomer(inv) || 'Unknown';
            const full = invWork(inv);
            const ini  = getInitials(invCustomer(inv) || '?');
            const work = full.slice(0, 34);
            const ticked = S.selectedInvs.includes(inv.docId);
            return `<div class="inv-item${ticked ? ' picked' : ''}" ${S.selectMode ? `data-pick="${inv.docId}"` : `data-inv="${inv.docId}"`}>
              ${S.selectMode
                ? `<div class="inv-check"><input type="checkbox" ${ticked ? 'checked' : ''} aria-label="Select ${cust}"></div>`
                : `<div class="inv-av">${ini}</div>`}
              <div class="inv-info">
                <div class="inv-name">${cust}</div>
                <div class="inv-meta">${work}${full.length > 34 ? '…' : ''} · ${fmtDate(inv.createdAt)}</div>
              </div>
              <div class="inv-right">
                <div class="inv-amt">${fmt(inv.amount || 0)}</div>
                <div style="margin-top:4px">${badge(inv.status || 'pending')}</div>
                ${inv.docId && !S.selectMode ? `<button onclick="event.stopPropagation();(function(){navigator.clipboard.writeText('https://portal-relay.com/doc/${inv.docId}');this.textContent='✓ Copied';setTimeout(()=>this.textContent='Share',1800)}).call(this)" style="margin-top:5px;font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;color:#374151">Share</button>` : ''}
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">
            ${S.filter==='all' ? 'No invoices yet — submit your first job!' :             `No ${S.filter} invoices found.`}
          </div>`
      }
    </div>
  </div>
  ${tabs('invoices')}`;
}

// A customer needs a consent answer if one was never recorded at all.
// Someone who was deliberately marked "Not yet" has been answered for and is
// not swept up by the bulk attestation.
function needsConsentAnswer(cx) {
  return !cx.smsConsent && !cx.smsConsentMethod;
}


// How a stored consent method reads on screen. 'sms_confirmed_by_contractor' and
// 'bulk_prior_relationship' are recorded by the SMS reply flow and the bulk
// attestation, so they are not offered in the dropdown but must still display.
const CONSENT_LABELS = {
  verbal:                      'Verbally - in person or by phone',
  inbound:                     'They texted or called me first',
  written:                     'In writing - signed form, email, or online',
  other:                       'Other',
  none:                        'Not yet - do not text this customer',
  sms_confirmed_by_contractor: 'Confirmed by you over text',
  bulk_prior_relationship:     'Bulk confirmation for imported customers',
};

function sEditCustomer() {
  const cx = (S.customers || []).find(c => c.docId === S.editCxId);
  if (!cx) return topbar({title: 'Customer', back: 'customers'}) +
    `<div class="scroll"><div class="card" style="padding:24px;text-align:center;color:#9ca3af">
      Customer not found. <span data-nav="customers" style="cursor:pointer;text-decoration:underline">Back to customers</span>
    </div></div>${tabs('customers')}`;

  const method = cx.smsConsentMethod || '';
  const scope  = cx.smsConsentScope || (cx.smsConsent ? 'all' : '');
  const known  = ['verbal','inbound','written','other','none'].includes(method);

  const statusLine = !cx.smsConsent
    ? `<span style="color:#9ca3af">Texting blocked - no permission on file</span>`
    : scope !== 'all'
      ? `<span style="color:#b45309">Documents only - review texts need permission answered here</span>`
      : `<span style="color:#059669">Texting allowed, including review requests</span>`;

  const recorded = method
    ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;line-height:1.5">
         On file: ${CONSENT_LABELS[method] || method}
         ${cx.smsConsentBy ? `<br>Recorded by ${cx.smsConsentBy}` : ''}
       </div>`
    : '';

  return topbar({title: cx.name || 'Customer', back: 'customers'}) +
  `<div class="scroll">
    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-weight:600;font-size:15px">${cx.name || 'Unknown'}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px">${cx.phone || ''}${cx.email ? ' &middot; ' + cx.email : ''}</div>
      ${cx.address ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${cx.address}</div>` : ''}
    </div>

    <p class="sh">Text Message Consent</p>
    <div class="card" style="padding:14px">
      <div style="font-size:13px;margin-bottom:10px">${statusLine}</div>
      <div class="form-group" style="margin-bottom:0">
        <label class="form-lbl" for="ecx-consent">How did this customer agree to receive texts from your business?</label>
        <select id="ecx-consent" class="input">
          <option value="">Select one</option>
          <option value="verbal"${method === 'verbal' ? ' selected' : ''}>Verbally &mdash; in person or by phone</option>
          <option value="inbound"${method === 'inbound' ? ' selected' : ''}>They texted or called me first</option>
          <option value="written"${method === 'written' ? ' selected' : ''}>In writing &mdash; signed form, email, or online</option>
          <option value="other"${method === 'other' ? ' selected' : ''}>Other</option>
          <option value="none"${method === 'none' ? ' selected' : ''}>Not yet &mdash; do not text this customer</option>
        </select>
        ${!known && method ? `<div style="font-size:12px;color:#b45309;margin-top:6px;line-height:1.5">
          Currently set by ${CONSENT_LABELS[method] || method}. Choosing an option above
          replaces it with a per-customer answer, which also unlocks review requests.
        </div>` : ''}
        ${recorded}
      </div>
      <!-- Review follow-up is a RelayPRO feature and is opt-in PER CUSTOMER.
           Asking someone for a review is the contractor's call about their own
           relationship, so nobody is invited by default. -->
      ${canReviewRequest((S.profile?.plan || '').toLowerCase()) ? `
      <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:14px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="ecx-followup" ${cx.reviewFollowUp ? 'checked' : ''}
                 style="margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:#6366f1">
          <span style="font-size:13px;color:#374151;line-height:1.55">
            <strong>Send a review follow-up to this customer</strong><br>
            <span style="font-size:12px;color:#6b7280">
              Their invoice will end with &ldquo;Reply YES and we'll text you a link to review our work.&rdquo;
              Relay only sends the review text if they reply YES themselves.
            </span>
          </span>
        </label>
      </div>` : `
      <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:14px;font-size:12px;color:#9ca3af;line-height:1.55">
        Automated review follow-up is a RelayPRO feature.
        <span data-nav="profile" style="color:#6366f1;cursor:pointer;text-decoration:underline">Upgrade to turn it on.</span>
      </div>`}
      <div id="ecx-err" class="auth-error" style="display:none;margin:10px 0 0"></div>
      <button id="ecx-save-btn" class="btn btn-primary" style="margin-top:12px" data-action="saveCustomerConsent">Save Permission</button>
    </div>
    <div style="height:20px"></div>
  </div>
  ${tabs('customers')}`;
}

function sInvoice() {
  const inv = (S.invoices || []).find(i => i.docId === S.openInvId);
  if (!inv) return topbar({title: 'Document', back: 'invoices'}) +
    `<div class="scroll"><div class="card" style="padding:24px;text-align:center;color:#9ca3af">
      Document not found. <span data-nav="invoices" style="cursor:pointer;text-decoration:underline">Back to documents</span>
    </div></div>${tabs('invoices')}`;

  const cust  = invCustomer(inv) || 'Unknown';
  const work  = invWork(inv);
  const email = invEmail(inv);
  const phone = invPhone(inv);
  const isQuote = (inv.type || 'invoice') === 'quote';

  const row = (label, value) => value
    ? `<div style="display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #f3f4f6">
         <span style="font-size:13px;color:#6b7280;flex-shrink:0">${label}</span>
         <span style="font-size:13px;text-align:right;word-break:break-word">${value}</span>
       </div>`
    : '';

  // Surfaced deliberately: a document held back by the parse guard should say
  // so on its own page, not just carry a badge in a list.
  const reviewNote = inv.status === 'needs_review' ? `
    <div class="card" style="padding:13px;margin-bottom:12px;border-left:3px solid #b45309">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">Held for your review</div>
      <div style="font-size:12px;color:#6b7280;line-height:1.55">
        Relay could not read this confidently, so it was not sent to the customer.
        Check the amount and details below${(inv.parseFlags||[]).length ? ` (${inv.parseFlags.join(', ')})` : ''}.
      </div>
    </div>` : '';

  const rawNote = inv.rawSms ? `
    <p class="sh">Original text</p>
    <div class="card" style="padding:13px;margin-bottom:12px">
      <div style="font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap">${inv.rawSms}</div>
    </div>` : '';

  return topbar({title: cust, back: 'invoices'}) +
  `<div class="scroll">
    ${reviewNote}
    <div class="card" style="padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <div style="font-size:20px;font-weight:700">${fmt(inv.amount || 0)}</div>
          <div style="font-size:13px;color:#6b7280;margin-top:2px">${isQuote ? 'Quote' : 'Invoice'} &middot; ${fmtDate(inv.createdAt)}</div>
        </div>
        ${badge(inv.status || 'pending')}
      </div>
    </div>

    ${work ? `<p class="sh">Work performed</p>
    <div class="card" style="padding:13px;margin-bottom:12px">
      <div style="font-size:13px;color:#374151;line-height:1.6">${work}</div>
    </div>` : ''}

    <p class="sh">Customer</p>
    <div class="card" style="padding:13px 14px;margin-bottom:12px">
      ${row('Name', cust)}
      ${row('Phone', phone ? formatPhone(phone) : '')}
      ${row('Email', email)}
      ${row('Address', inv.address)}
    </div>

    <p class="sh">Details</p>
    <div class="card" style="padding:13px 14px;margin-bottom:12px">
      ${row('Type', isQuote ? 'Quote' : 'Invoice')}
      ${row('Job type', inv.job_type)}
      ${row('Source', inv.source === 'sms' ? 'Texted in' : 'Created in portal')}
      ${row('PO / Job ref', inv.poRef)}
      ${row('Warranty', inv.warranty)}
      ${row('Deposit', inv.deposit)}
      ${row('Notes', inv.notes)}
    </div>

    ${rawNote}

    <button class="btn btn-primary" style="margin-bottom:8px"
            onclick="window.open('/doc/${inv.docId}','_blank','noopener')">
      View / Print PDF
    </button>
    <button class="btn btn-outline" style="margin-bottom:10px"
            onclick="navigator.clipboard.writeText('https://portal-relay.com/doc/${inv.docId}');this.textContent='\u2713 Link copied';setTimeout(()=>this.textContent='Copy shareable link',1800)">
      Copy shareable link
    </button>
    ${inv.status !== 'paid' ? `<button class="btn btn-primary" data-action="markInvoicePaid">Mark as Paid</button>` : ''}
    <div style="height:20px"></div>
  </div>
  ${tabs('invoices')}`;
}

function sCustomers() {
  const cxs     = S.customers || [];
  const pending = cxs.filter(needsConsentAnswer);

  // Customers without a permission answer are listed so they can be answered
  // one at a time. There is deliberately no way to answer for all of them at
  // once: a single click covering an imported list is an attestation nobody
  // made about people who never agreed to anything, and it is the one feature
  // in this product capable of generating hundreds of TCPA violations from one
  // action. Each customer is approved individually, on their own page.
  const pendingBanner = pending.length ? `
    <div class="card" style="padding:14px;margin-bottom:12px;border-left:3px solid #f59e0b">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px">
        ${pending.length} customer${pending.length === 1 ? '' : 's'} can't be texted yet
      </div>
      <div style="font-size:12px;color:#6b7280;line-height:1.55">
        These were added or imported without a text message permission answer, so
        Relay will not text them. Open each one and record how they agreed to
        receive texts from your business. Permission is answered per customer &mdash;
        you are the sender of record, and a real answer for each person is what
        protects you.
      </div>
    </div>` : '';

  return topbar({title:'Customers', sub:`${cxs.length} total`}) +
  `<div class="scroll" style="padding:12px 16px">
    ${pendingBanner}
    <button class="add-customer-cta" data-nav="addCustomer">
      <span class="add-customer-icon">+</span>
      <span class="add-customer-text">
        <span class="add-customer-title">Add New Customer</span>
        <span class="add-customer-sub">Log Contact, Billing &amp; Dispatch Info</span>
      </span>
    </button>
    <div class="card">
      ${cxs.length
        ? cxs.map(cx => {
            const ini = getInitials(cx.name || '?');
            const col = avatarColor(cx.name || '');
            return `<div class="inv-item" data-cx="${cx.docId}" style="cursor:pointer">
              <div class="inv-av" style="background:${col.bg};color:${col.fg}">${ini}</div>
              <div class="inv-info">
                <div class="inv-name">${cx.name || 'Unknown'}</div>
                <div class="inv-meta">${cx.phone || ''}${cx.email ? ' · ' + cx.email : ''}</div>
                <div class="inv-meta" style="margin-top:2px;font-size:11px;color:${!cx.smsConsent ? '#9ca3af' : (cx.smsConsentScope && cx.smsConsentScope !== 'all') ? '#b45309' : '#059669'}">
                  ${!cx.smsConsent
                      ? 'Texting blocked \u2014 no permission on file'
                      : (cx.smsConsentScope && cx.smsConsentScope !== 'all')
                        ? 'Documents only \u2014 review texts need per-customer permission'
                        : 'Texting allowed'}
                </div>
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">
            No customers here yet. Add one above, or just text in a job and Relay
            will create the customer for you.
          </div>`
      }
    </div>
  </div>
  ${tabs('customers')}`;
}
function sAddCustomer() {
  const platform = S.profile?.platform === 'zoho' ? 'Zoho' : 'QuickBooks';
  return topbar({title: 'Add New Customer', back: 'customers'}) +
  `<div class="scroll">

    <!-- ── Required. Everything needed to save is above the fold. ── -->
    <p class="sh" style="margin-top:2px">Required</p>
    <div class="form-group"><label class="form-lbl" for="cx-name">Customer name <span class="req">*</span></label><input id="cx-name" type="text" class="input" placeholder="e.g. Jeff Smith" autocomplete="off"></div>
    <div class="form-group"><label class="form-lbl" for="cx-phone">Phone <span class="req">*</span></label><input id="cx-phone" type="tel" class="input" placeholder="(616) 248-1977"></div>
    <div class="form-group"><label class="form-lbl" for="cx-addr">Primary service address <span class="req">*</span></label><input id="cx-addr" type="text" class="input" placeholder="412 Oak St, Grand Rapids MI" autocomplete="off"></div>

    <div class="form-group">
      <label class="form-lbl" for="cx-consent-how">Text message permission <span class="req">*</span></label>
      <select id="cx-consent-how" class="input">
        <option value="">Select one &mdash; required</option>
        <option value="verbal">Verbally &mdash; in person or by phone</option>
        <option value="inbound">They texted or called me first</option>
        <option value="written">In writing &mdash; signed form, email, or online</option>
        <option value="other">Other</option>
        <option value="none">Not yet &mdash; do not text this customer</option>
      </select>
      <span style="font-size:12px;color:#6b7280;line-height:1.5;display:block;margin-top:6px;">
        Relay will not text this customer unless one of the first four is selected.
        Pick the one that is actually true &mdash; you are the sender of record, and
        this is the record that protects you. Answering here covers both job
        documents and review request texts. Customers can reply STOP at any time.
      </span>
    </div>

    <div id="cx-err" class="auth-error" style="display:none;margin-bottom:10px"></div>
    <button id="cx-save-btn" class="btn btn-primary" data-action="saveCustomer">Save Customer</button>
    <p style="font-size:12px;color:#9ca3af;text-align:center;margin:8px 0 0;line-height:1.5">
      That&rsquo;s everything required. Anything below is optional &mdash; add it now
      or update it later from the customer&rsquo;s page.
    </p>

    <div style="height:1px;background:#e5e7eb;margin:22px 0 4px"></div>

    <!-- ── Optional. Same fields as before, ordered by how often they matter. ── -->
    <p class="sh">Contact</p>
    <div class="form-group"><label class="form-lbl" for="cx-email">Email</label><input id="cx-email" type="email" class="input" placeholder="For document delivery"></div>
    <div class="form-group"><label class="form-lbl" for="cx-addr2">Additional service address</label><input id="cx-addr2" type="text" class="input" placeholder="For customers with more than one property"></div>

    <p class="sh">Billing</p>
    <div class="form-group"><label class="form-lbl" for="cx-billname">Billing name / company</label><input id="cx-billname" type="text" class="input" placeholder="Leave blank if same as customer name"></div>
    <div class="form-group"><label class="form-lbl" for="cx-billaddr">Billing address</label><input id="cx-billaddr" type="text" class="input" placeholder="Leave blank if same as service address"></div>
    <div class="input-row">
      <div class="form-group"><label class="form-lbl" for="cx-paymethod">Preferred payment method</label>
        <select id="cx-paymethod" class="input">
          <option value="">Not set</option>
          <option>Cash</option><option>Check</option><option>Zelle</option><option>Venmo</option><option>CashApp</option><option>Credit / Debit Card</option>
        </select>
      </div>
      <div class="form-group"><label class="form-lbl" for="cx-terms">Default payment terms</label>
        <select id="cx-terms" class="input">
          <option value="">Not set</option>
          <option>Due on receipt</option><option>Net 15</option><option>Net 30</option>
        </select>
      </div>
    </div>

    <p class="sh">Accounting</p>
    <div class="form-group"><label class="form-lbl" for="cx-acctid">${platform} customer ID</label><input id="cx-acctid" type="text" class="input" placeholder="Prevents duplicate customer records on sync"></div>
    <label class="check-row-lbl">
      <input type="checkbox" id="cx-taxexempt">
      <span>This customer is tax-exempt</span>
    </label>

    <p class="sh">Dispatch Details</p>
    <div class="form-group"><label class="form-lbl" for="cx-type">Customer type</label>
      <select id="cx-type" class="input">
        <option value="">Not set</option>
        <option>Residential</option><option>Commercial</option><option>Property Manager</option><option>Insurance</option>
      </select>
    </div>
    <div class="input-row">
      <div class="form-group"><label class="form-lbl" for="cx-sec-name">Secondary contact name</label><input id="cx-sec-name" type="text" class="input" placeholder="e.g. property manager"></div>
      <div class="form-group"><label class="form-lbl" for="cx-sec-phone">Secondary contact phone</label><input id="cx-sec-phone" type="tel" class="input" placeholder="Optional"></div>
    </div>
    <div class="form-group"><label class="form-lbl" for="cx-access">Access notes</label><textarea id="cx-access" class="input" placeholder="Gate code, pets, parking, entry instructions"></textarea></div>

    <p class="sh">Notes</p>
    <div class="form-group"><label class="form-lbl" for="cx-referral">Referral source</label><input id="cx-referral" type="text" class="input" placeholder="How did they find you?"></div>
    <div class="form-group"><label class="form-lbl" for="cx-notes">General notes</label><textarea id="cx-notes" class="input" placeholder="Anything else worth remembering about this customer"></textarea></div>

    <div id="cx-err2" class="auth-error" style="display:none;margin-bottom:10px"></div>
    <button id="cx-save-btn2" class="btn btn-primary" data-action="saveCustomer">Save Customer</button>
    <div style="height:20px"></div>
  </div>
  ${tabs('customers')}`;
}

function sProfile() {
  const p    = S.profile || {};
  const plan = (p.plan || 'unpaid').toLowerCase();
  const sub  = p.subscriptionStatus || 'unpaid';
  // RelayPRO-only section. canAutoForward() is Pro-only, so this gate was always
  // correct, but the old name (isEssentialPlus) said the opposite and invited a
  // maintainer to widen it.
  const isPro = canReviewRequest(plan);
  const canSMS = canSMSDispatch(plan);
  const isAdmin = S.user?.email === ADMIN_EMAIL;

  const billingRow = (isAdmin || sub === 'active' || sub === 'trialing') ? `
    <a href="${STRIPE_BILLING}" target="_blank" rel="noopener"
       class="btn btn-outline" style="margin-bottom:8px;display:block;text-align:center">
      ${I.card} Manage billing &amp; subscription
    </a>` : '';

  const planBadge = isAdmin
    ? `<span class="badge paid">Admin</span>`
    : sub === 'active' || sub === 'trialing'
      ? `<span class="badge paid">${planLabel(p.plan)} Plan · ${subLabel(sub)}</span>`
      : `<span class="badge overdue">No active plan</span>`;

  const bizTypes = ['Plumbing','Electrical','HVAC / Mechanical','Roofing','General Contracting',
    'Property Management','Landscaping / Lawn Care','Pest Control','Cleaning Services',
    'Painting','Flooring','Appliance Repair','Other'];

  const payMethods = ['Cash','Check','Zelle','Venmo','CashApp','Credit / Debit Card'];
  const savedMethods = p.paymentMethods || [];
  const savedMethodOther = p.paymentMethodOther || '';

  const validityOpts = ['7 days','14 days','30 days','60 days','90 days'];

  const _umDefs = [
    {m:'Zelle',              id:'zelle',          label:'Zelle phone or email',      ph:'e.g. (555) 867-5309 or you@email.com'},
    {m:'Venmo',              id:'venmo',           label:'Venmo @username',            ph:'e.g. @JohnSmithPlumbing'},
    {m:'CashApp',            id:'cashapp',         label:'CashApp $cashtag',           ph:'e.g. $SmithHVAC'},
    {m:'Credit / Debit Card',id:'creditdebitcard', label:'Payment link or processor',  ph:'e.g. Square, PayPal.me/yourname'},
  ];
  const savedUsernames = p.paymentUsernames || {};
  const payMethodCheckboxes = payMethods.map(m => {
    const id = m.replace(/[^a-z]/gi,'').toLowerCase();
    const checked = savedMethods.includes(m);
    const needsUser = _umDefs.find(u => u.m === m);
    const chg = needsUser
      ? `onchange="(function(el){var w=document.getElementById('pf-pay-user-wrap-${id}');if(w)w.style.display=el.checked?'block':'none';el.closest('label').style.background=el.checked?'#eff6ff':'#fff';})(this)"`
      : `onchange="this.closest('label').style.background=this.checked?'#eff6ff':'#fff'"`;
    return `<label style="display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #e5e7eb;border-radius:9px;cursor:pointer;font-size:13px;font-weight:500;color:#374151;background:${checked?'#eff6ff':'#fff'}">`
      + `<input type="checkbox" id="pf-pay-${id}" value="${m}" ${checked?'checked':''} style="accent-color:#1d4ed8;width:15px;height:15px" ${chg}>`
      + `${m}</label>`;
  }).join('');
  const usernameFields = _umDefs.map(({m, id, label, ph}) => {
    const checked = savedMethods.includes(m);
    const val = savedUsernames[m] || '';
    return `<div id="pf-pay-user-wrap-${id}" style="display:${checked?'block':'none'};margin-bottom:8px;padding:10px 12px;background:#f0f7ff;border:1px solid #bfdbfe;border-radius:9px">`
      + `<label class="form-lbl" style="font-size:11px;margin-bottom:4px">${label} <span style="color:#dc2626">*</span></label>`
      + `<input id="pf-pay-user-${id}" type="text" class="input" value="${val}" placeholder="${ph}" style="margin-bottom:0;font-size:13px">`
      + `<div style="font-size:10px;color:#6b7280;margin-top:3px">Shown to your customer so they know where to send payment.</div>`
      + `</div>`;
  }).join('');
  const _plat = p.platform || 'none';
  const _uid  = S.user?.uid || '';
  const _iqUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${INTUIT_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=com.intuit.quickbooks.accounting&response_type=code&state=qb_${_uid}`;
  const _zhUrl = `https://accounts.zoho.com/oauth/v2/auth?client_id=${ZOHO_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=ZohoBooks.fullaccess.all,AaaServer.profile.READ&response_type=code&access_type=offline&prompt=consent&state=zoho_${_uid}`;
  const acctSoftwareHtml = `<div style="display:flex;flex-direction:column;gap:8px">
      <button type="button" class="acct-plat-btn" onclick="(function(b){document.getElementById('pf-platform').value='quickbooks';document.querySelectorAll('.acct-plat-btn').forEach(x=>x.removeAttribute('data-sel'));b.setAttribute('data-sel','1');if('${INTUIT_CLIENT_ID}'!=='YOUR_INTUIT_CLIENT_ID_HERE')window.open('${_iqUrl}','_blank');})(this)"
        style="display:flex;align-items:center;gap:12px;padding:13px 14px;border:2px solid ${_plat==='quickbooks'?'#2ca01c':'#e5e7eb'};border-radius:11px;background:${_plat==='quickbooks'?'#f0fdf4':'#fff'};cursor:pointer;text-align:left">
        <div style="width:32px;height:32px;background:#2ca01c;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="color:#fff;font-size:13px;font-weight:800">QB</span></div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700;color:#111827">QuickBooks Online</div><div style="font-size:11px;color:#6b7280;margin-top:1px">Intuit — automatic invoice sync</div></div>
        ${_plat==='quickbooks'?'<span style="font-size:11px;font-weight:700;color:#16a34a;background:#dcfce7;padding:3px 8px;border-radius:20px">● Connected</span>':'<span style="font-size:11px;color:#9ca3af">Connect →</span>'}
      </button>
      <button type="button" class="acct-plat-btn" onclick="(function(b){document.getElementById('pf-platform').value='zoho';document.querySelectorAll('.acct-plat-btn').forEach(x=>x.removeAttribute('data-sel'));b.setAttribute('data-sel','1');if('${ZOHO_CLIENT_ID}'!=='YOUR_ZOHO_CLIENT_ID_HERE')window.open('${_zhUrl}','_blank');})(this)"
        style="display:flex;align-items:center;gap:12px;padding:13px 14px;border:2px solid ${_plat==='zoho'?'#e07b39':'#e5e7eb'};border-radius:11px;background:${_plat==='zoho'?'#fff7ed':'#fff'};cursor:pointer;text-align:left">
        <div style="width:32px;height:32px;background:#e07b39;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="color:#fff;font-size:13px;font-weight:800">Z</span></div>
        <div style="flex:1"><div style="font-size:13px;font-weight:700;color:#111827">Zoho Books</div><div style="font-size:11px;color:#6b7280;margin-top:1px">Zoho — automatic invoice sync</div></div>
        ${_plat==='zoho'?'<span style="font-size:11px;font-weight:700;color:#e07b39;background:#fff7ed;border:1px solid #fed7aa;padding:3px 8px;border-radius:20px">● Connected</span>':'<span style="font-size:11px;color:#9ca3af">Connect →</span>'}
      </button>
      <button type="button" class="acct-plat-btn" onclick="(function(b){document.getElementById('pf-platform').value='none';document.querySelectorAll('.acct-plat-btn').forEach(x=>x.removeAttribute('data-sel'));b.setAttribute('data-sel','1');})(this)"
        style="padding:11px 14px;border:2px solid ${(_plat==='none'||!_plat)?'#6b7280':'#e5e7eb'};border-radius:11px;background:${(_plat==='none'||!_plat)?'#f9fafb':'#fff'};cursor:pointer;font-size:13px;font-weight:500;color:#6b7280;text-align:center">
        ${(_plat==='none'||!_plat)?'✓ Not connecting software':'Do not connect software'}
      </button>
    </div>`;

  return topbar({title:'Account Settings', back:'dashboard'}) +
    `<div class="scroll">

      <!-- ── Company Header ── -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom
20px;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px">
        <div style="width:50px;height:50px;border-radius:12px;background:linear-gradient(135deg,#0f1f45,#1d4ed8);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;font-weight:800;flex-shrink:0">
          ${getInitials(p.companyName||'?')}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:15px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.companyName||'My Company'}</div>
          <div style="margin-top:3px">${planBadge}</div>
        </div>
      </div>

      <!-- ── Monthly usage meter ── -->
      ${usageMeter(plan)}

      <!-- ── Business Info ── -->
      <p class="sh">Business Info</p>
      <div class="form-group">
        <label class="form-lbl" for="pf-phone">Your business phone number <span class="req">*</span></label>
        <input id="pf-phone" type="tel" class="input" value="${p.phoneNumber ? formatPhone(p.phoneNumber) : ''}" placeholder="(616) 248-1977">
        <div style="font-size:12px;color:#6b7280;margin-top:4px;line-height:1.5">
          This is how Relay knows a job text is from you. It must be the phone you
          text from. Without it, texting a job to (844) 729-1376
          returns &ldquo;not registered&rdquo; and nothing is created.
        </div>
      </div>
      <div class="form-group">
        <label class="form-lbl" for="pf-co">Company / DBA name</label>
        <input id="pf-co" type="text" class="input" value="${p.companyName||''}" placeholder="Your business name">
      </div>
      <div class="form-group">
        <label class="form-lbl" for="pf-biztype">Business type / trade</label>
        <select id="pf-biztype" class="input" onchange="document.getElementById('pf-biztype-other-wrap').style.display=this.value==='Other'?'block':'none'">
          <option value="">— Select your trade —</option>
          ${bizTypes.map(t => `<option${(p.businessType===t||(!p.businessType&&t==='General Contracting'))?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div id="pf-biztype-other-wrap" class="form-group" style="display:${p.businessType==='Other'?'block':'none'}">
        <label class="form-lbl" for="pf-biztype-other">Describe your trade</label>
        <input id="pf-biztype-other" type="text" class="input" value="${p.businessTypeOther||''}" placeholder="e.g. Pool Service, Fire Suppression...">
      </div>
      <div class="form-group">
        <label class="form-lbl" for="pf-license">Business license / contractor #</label>
        <input id="pf-license" type="text" class="input" value="${p.licenseNumber||''}" placeholder="e.g. LIC-12345 (optional — prints on invoices)">
      </div>
      <input type="hidden" id="pf-platform" value="${p.platform||'none'}">

      <!-- ── Pricing Defaults ── -->
      <p class="sh">Pricing Defaults</p>
      <div class="input-row">
        <div class="form-group">
          <label class="form-lbl" for="pf-callFee">Min. service call fee ($)</label>
          <input id="pf-callFee" type="number" class="input" value="${p.minCallFee||0}" min="0" step="5" placeholder="0">
        </div>
        <div class="form-group">
          <label class="form-lbl" for="pf-tax">Tax rate (%)</label>
          <input id="pf-tax" type="number" class="input" value="${p.taxRate||0}" min="0" step="0.1" placeholder="e.g. 8.25">
        </div>
      </div>
      <div class="form-group">
        <label class="form-lbl">Default payment terms</label>
        <select id="pf-terms" class="input">
          ${['Due on receipt','Net 7','Net 15','Net 30','Net 45'].map(t=>`<option${p.paymentTerms===t?' selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-lbl">Estimate validity window</label>
        <select id="pf-validity" class="input">
          ${validityOpts.map(v=>`<option${p.estimateValidity===v?' selected':''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-lbl" for="pf-invprefix">Invoice number prefix</label>
        <input id="pf-invprefix" type="text" class="input" value="${p.invoicePrefix||''}" placeholder="e.g. INV- or PPS- (optional)">
      </div>

      <!-- ── Payment Methods ── -->
      <p class="sh">Payment Methods Accepted</p>
      <p style="font-size:12px;color:#6b7280;margin:-8px 0 10px">Select every method you accept. For digital payments, enter your handle so customers know exactly where to send money.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${payMethodCheckboxes}
        <label style="display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #e5e7eb;border-radius:9px;cursor:pointer;font-size:13px;font-weight:500;color:#374151;background:${savedMethodOther?'#eff6ff':'#fff'}">
          <input type="checkbox" id="pf-pay-other-chk" ${savedMethodOther?'checked':''} style="accent-color:#1d4ed8;width:15px;height:15px"
            onchange="document.getElementById('pf-pay-other-wrap').style.display=this.checked?'block':'none';this.closest('label').style.background=this.checked?'#eff6ff':'#fff'">
          Other
        </label>
      </div>
      ${usernameFields}
      <div id="pf-pay-other-wrap" style="display:${savedMethodOther?'block':'none'};margin-bottom:14px">
        <input id="pf-pay-other" type="text" class="input" value="${savedMethodOther}" placeholder="Describe other payment method...">
      </div>

      <!-- ── Invoice Defaults ── -->
      <p class="sh">Invoice Defaults</p>
      <div class="form-group">
        <label class="form-lbl" for="pf-footer">Default invoice footer / notes</label>
        <textarea id="pf-footer" class="input" placeholder="e.g. Thank you for choosing us! Payment appreciated within stated terms.">${p.invoiceFooter||''}</textarea>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">Appears at the bottom of every invoice and quote.</div>
      </div>

      ${canSMS ? `
      <p class="sh">SMS Dispatch</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#166534">
        <strong>Relay dispatch line:</strong> +1 (844) 729-1376 — text job info to generate invoices via AI.
      </div>` : ''}

      ${isPro ? `
      <p class="sh">Relay Pro <span class="badge paid" style="font-size:11px;margin-left:4px">Pro</span></p>
      <div class="form-group">
        <label class="form-lbl" for="pf-review-url">Google / Yelp review link</label>
        <input id="pf-review-url" type="url" class="input" value="${p.reviewUrl||''}" placeholder="https://g.page/your-business/review">
        <div style="font-size:12px;color:#6b7280;margin-top:4px">Sent to customer via SMS after job completion.</div>
      </div>
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;margin-bottom:16px;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px">
        <input id="pf-autofwd" type="checkbox" ${p.autoForwardToCustomer?'checked':''} style="width:18px;height:18px;accent-color:#1d4ed8;margin-top:1px;flex-shrink:0">
        <div>
          <div style="font-size:14px;font-weight:600;color:#111827">Auto-forward invoice to customer</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">AI-generated invoice sent to customer via SMS after every dispatch.</div>
        </div>
      </label>` : (canSMS ? `
      <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px;margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:4px">Pro features locked</div>
        <div style="font-size:12px;color:#92400e">Upgrade to Pro to unlock auto-forward and review SMS.</div>
        <a href="${STRIPE_PRO}" target="_blank" rel="noopener" style="font-size:12px;color:#1a2f5e;font-weight:600;text-decoration:underline">Upgrade now →</a>
      </div>` : '')}

      <!-- ── Connect Invoicing Software ── -->
      <p class="sh" style="margin-top:4px">Connect Your Invoicing Software</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:16px">
        <p style="font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.5">Connect QuickBooks or Zoho Books and Relay will automatically log every invoice into your accounting software on your behalf — no double entry.</p>
        ${acctSoftwareHtml}
      </div>

      <div id="pf-err" class="auth-error" style="display:none;margin-bottom:10px"></div>
      <button id="pf-save" class="btn btn-primary" data-action="saveProfile" style="margin-bottom:12px">Save Changes</button>
      ${billingRow}
      <button class="btn btn-outline" data-action="signOut" style="margin-bottom:28px">${I.logout} Sign Out</button>
    </div>
    ${tabs('profile')}`;
}


function sAdmin() {
  return topbar({title:'Admin', back:'dashboard'}) +
    `<div class="scroll">
      <p style="font-size:13px;color:#6b7280;margin-bottom:14px">Admin panel — coming soon.</p>
    </div>`;
}

const SCREENS = {
  loading:   sLoading,
  login:     sLogin,
  signup:    sSignup,
  locked:    sLocked,
  plans:     sPlans,
  dashboard: sDashboard,
  submit:    sSubmit,
  confirm:   sConfirm,
  invoices:  sInvoices,
  customers: sCustomers,
  addCustomer: sAddCustomer,
  editCustomer: sEditCustomer,
  invoice: sInvoice,
  profile:   sProfile,
  admin:     sAdmin,
};
function render() {
  const fn = SCREENS[S.screen] || sLoading;
  $('app').innerHTML = fn();
  const ldr = document.getElementById('loader'); if (ldr) ldr.style.display = 'none';
}

function nav(screen) {
  const user    = S.user;
  const isAdmin = user?.email === ADMIN_EMAIL;
  const status  = S.profile?.subscriptionStatus;

  // Guard protected screens
  if (PROTECTED.has(screen) && !isAdmin) {
    const canAccess = ['active', 'trialing', 'past_due'].includes(status);
    if (!canAccess) {
      S.screen = 'locked';
      render();
      return;
    }
  }

  S.screen = screen;
  render();
  window.scrollTo(0, 0);
}

// ── EVENT DELEGATION ──────────────────────────────────────────────────────

document.addEventListener('click', async e => {
  const navEl    = e.target.closest('[data-nav]');
  const actionEl = e.target.closest('[data-action]');
  const toggleEl = e.target.closest('[data-toggle]');
  const filterEl = e.target.closest('[data-filter]');

  const pickEl = e.target.closest('[data-pick]');
  if (pickEl) {
    e.preventDefault();
    const id = pickEl.dataset.pick;
    S.selectedInvs = S.selectedInvs.includes(id)
      ? S.selectedInvs.filter(x => x !== id)
      : [...S.selectedInvs, id];
    render();
    return;
  }
  const invEl = e.target.closest('[data-inv]');
  if (invEl)    { e.preventDefault(); S.openInvId = invEl.dataset.inv; nav('invoice'); return; }
  const cxEl = e.target.closest('[data-cx]');
  if (cxEl)     { e.preventDefault(); S.editCxId = cxEl.dataset.cx; nav('editCustomer'); return; }
  if (navEl)    { e.preventDefault(); nav(navEl.dataset.nav); return; }
  if (filterEl) { S.filter = filterEl.dataset.filter; render(); return; }
  if (toggleEl) {
    const { toggle, val } = toggleEl.dataset;
    if (toggle === 'type')  S.formType  = val;
    if (toggle === 'price') S.formPrice = val;
    render();
    return;
  }
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ── LOGIN ──
  if (action === 'login') {
    const email = $('lg-email')?.value?.trim();
    const pw    = $('lg-pw')?.value;
    if (!email || !pw) { showErr('lg-err', 'Please enter your email and password.'); return; }
    setBtn('lg-btn', true, 'Sign In To Relay');
    try {
      await auth.signInWithEmailAndPassword(email, pw);
    } catch(err) {
      showErr('lg-err', friendlyAuthError(err.code));
      setBtn('lg-btn', false, 'Sign In To Relay');
    }
    return;
  }

  // ── GOOGLE LOGIN ──
  if (action === 'googleLogin') {
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch(err) {
      showErr(S.screen === 'signup' ? 'sg-err' : 'lg-err', friendlyAuthError(err.code));
    }
    return;
  }

  // ── SIGN UP ──
  if (action === 'signup') {
    const co    = $('sg-co')?.value?.trim();
    const email = $('sg-email')?.value?.trim();
    const pw    = $('sg-pw')?.value;
    const pw2   = $('sg-pw2')?.value;
    const plat  = $('sg-platform')?.value || 'quickbooks';
    if (!co)          { showErr('sg-err', 'Please enter your company name.'); return; }
    if (!email)       { showErr('sg-err', 'Please enter your email.'); return; }
    if (pw !== pw2)   { showErr('sg-err', 'Passwords do not match.'); return; }

    // The phone number is the identity every inbound job text is matched on,
    // and the consent box is the record that authorises texting it. Both were
    // read and stored but neither was ever checked, so accounts existed that
    // could not text in and accounts existed that we texted without consent.
    const sgPhoneRaw = ($('sg-phone')?.value || '').trim();
    if (!toE164(sgPhoneRaw)) {
      showErr('sg-err', 'Please enter a valid 10-digit mobile number — this is the number you text jobs from.');
      return;
    }
    if (!$('sg-sms')?.checked) {
      showErr('sg-err', 'Please check the box agreeing to receive text messages — Relay works over SMS, so we cannot set up your account without it.');
      return;
    }
    setBtn('sg-btn', true, 'Create My Relay Account');
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      const phone      = ($('sg-phone')?.value || '').trim();
      const smsConsent = !!$('sg-sms')?.checked;
      await db.collection('users').doc(cred.user.uid).set({
        companyName:        co,
        platform:           plat,
        plan:               'starter',
        subscriptionStatus: 'unpaid',
        // phoneNumber is what twilio-sms and oauth-refresh-sweep query. Signup
        // previously wrote only `phone`, a field NOTHING reads, so every new
        // account was unable to text in from the moment it was created.
        // Both are written: phoneNumber/phoneDigits are canonical, `phone`
        // stays for older code paths that still read it.
        phone:              phone,
        phoneNumber:        toE164(phone),
        phoneDigits:        phoneDigits(phone),
        smsConsent:         smsConsent,
        createdAt:          firebase.firestore.FieldValue.serverTimestamp(),
      });
      // send-welcome-sms function not yet deployed — skip for now
    } catch(err) {
      showErr('sg-err', friendlyAuthError(err.code));
      setBtn('sg-btn', false, 'Create My Relay Account');
    }
    return;
  }

  // ── SIGN OUT ──
  if (action === 'signOut') {
    await auth.signOut();
    S.user = null; S.profile = null; S.invoices = []; S.customers = [];
    nav('login');
    return;
  }

  // ── SUBMIT JOB ──
  if (action === 'submitJob') {
    const name  = $('f-name')?.value?.trim();
    const phone = $('f-phone')?.value?.trim();
    const addr  = $('f-addr')?.value?.trim();
    const work  = $('f-work')?.value?.trim();
    const poRef    = $('f-poref')?.value?.trim() || '';
    const warranty = $('f-warranty')?.value?.trim() || '';
    const deposit  = S.formType === 'quote' ? ($('f-deposit')?.value?.trim() || '') : '';
    if (!name || !phone || !addr || !work) {
      showErr('sub-err', 'Please fill in all required fields (*).');
      return;
    }
    let amount = 0;
    if (S.formPrice === 'flat') {
      amount = parseFloat(($('f-total')?.value || '0').replace(/[^0-9.]/g, '')) || 0;
    } else {
      const mat = parseFloat(($('f-mat')?.value || '0').replace(/[^0-9.]/g, '')) || 0;
      const lab = parseFloat(($('f-lab')?.value || '0').replace(/[^0-9.]/g, '')) || 0;
      amount = mat + lab;
    }    setBtn('sub-btn', true, 'Send To Relay Dispatch');
    try {
      const uid  = S.user.uid;
      const plan = (S.profile?.plan || 'unpaid').toLowerCase();
      try {
        await checkAndIncrementDocCount(uid, plan);
      } catch(limitErr) {
        if (limitErr.message === 'DOC_LIMIT_REACHED') {
          showErr('sub-err', `Monthly document limit reached (${limitErr.limit} docs/mo on your plan). Please upgrade to continue.`);
          setBtn('sub-btn', false, 'Send To Relay Dispatch');
          return;
        }
        throw limitErr;
      }
      const invRef = await db.collection('users').doc(uid).collection('invoices').add({
        customer:  name,
        phone,
        email:     $('f-email')?.value?.trim() || '',
        address:   addr,
        work,
        amount,
        type:      S.formType,
        status:    'pending',
        notes:     $('f-notes')?.value?.trim() || '',
        poRef,
        warranty,
        deposit,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        platform:  S.profile?.accountingProvider || S.profile?.platform || 'none',
        sentAt:              new Date(),
        reviewRequestSent:   false,
      });
      await db.collection('dispatch').add({
        userId:      uid,
        invoiceId:   invRef.id,
        poRef,
        warranty,
        deposit,
        customer:    name,
        phone,
        address:     addr,
        work,
        amount,
        type:        S.formType,
        status:      'pending',
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        sentAt:              new Date(),
        reviewRequestSent:   false,
      });

      await db.collection('publicDocs').doc(invRef.id).set({
        // Owner stamp. publicDocs is world-readable (these are share links), so
        // the security rule scopes WRITES to the owner - which needs this field.
        uid,
        companyName:        S.profile?.companyName   || '',
        businessType:       S.profile?.businessType  || '',
        licenseNumber:      S.profile?.licenseNumber || '',
        invoicePrefix:      S.profile?.invoicePrefix || '',
        paymentMethods:     S.profile?.paymentMethods    || [],
        paymentMethodOther: S.profile?.paymentMethodOther|| '',
       paymentUsernames:    S.profile?.paymentUsernames   || {},
        invoiceFooter:      S.profile?.invoiceFooter  || '',
        paymentTerms:       S.profile?.paymentTerms   || 'Due on receipt',
        estimateValidity:   S.profile?.estimateValidity|| '',
        taxRate:            S.profile?.taxRate         || 0,
        minCallFee:         S.profile?.minCallFee      || 0,
        poRef,
        warranty,
        deposit,
        customer:  name,
        email:     $('f-email')?.value?.trim() || '',
        address:   addr,
        work,
        amount,
        type:      S.formType,
        status:    'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      S.lastJob = { type: S.formType, customer: name, amount: fmt(amount), docId: invRef.id };
      await loadUserData(uid);
      nav('confirm');
    } catch(err) {
      console.error('submitJob:', err);
      showErr('sub-err', 'Submission failed — please try again.');
      setBtn('sub-btn', false, 'Send To Relay Dispatch');
    }
    return;
  }

  // ── SAVE CUSTOMER ──
  // ── SAVE CONSENT FOR AN EXISTING CUSTOMER ──
  // A per-customer answer always records scope 'all', so it also unlocks review
  // requests - which is the only way to upgrade a bulk-attested customer.
  if (action === 'startSelect')  { S.selectMode = true;  S.selectedInvs = []; render(); return; }
  if (action === 'cancelSelect') { S.selectMode = false; S.selectedInvs = []; render(); return; }

  if (action === 'selectAllInvs') {
    const visible = (S.filter === 'all' ? (S.invoices || []) : (S.invoices || []).filter(i => i.status === S.filter))
      .map(i => i.docId);
    const allPicked = visible.length > 0 && visible.every(id => S.selectedInvs.includes(id));
    S.selectedInvs = allPicked ? [] : visible;
    render();
    return;
  }

  // Delete selected documents.
  //
  // The invoice is SOFT deleted - marked and hidden, never destroyed. It is a
  // financial record, and a mis-tap should not be able to erase proof that work
  // was billed. The customer-facing copy in publicDocs is HARD deleted, so any
  // share link already sent stops working immediately; that is the part that
  // actually matters once a document is withdrawn.
  if (action === 'deleteSelected') {
    const uid = S.user?.uid;
    if (!uid || !S.selectedInvs.length) return;
    const ids = [...S.selectedInvs];
    const btn = document.querySelector('[data-action="deleteSelected"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    const failedIds = [];
    for (const id of ids) {
      try {
        await db.collection('users').doc(uid).collection('invoices').doc(id).update({
          deleted:   true,
          deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // Revoke the share link. A missing public copy is not an error - SMS
        // documents created before publicDocs was written have none.
        await db.collection('publicDocs').doc(id).delete().catch(() => {});
      } catch (err) {
        console.error('deleteSelected:', id, err);
        failedIds.push(id);
      }
    }

    // The failure message used to be written into #inv-del-err and then
    // immediately destroyed: select mode was switched off and render() ran
    // straight after, and that element only exists while select mode is on. A
    // partial failure was therefore completely silent - documents stayed put
    // and the user was told nothing.
    //
    // On any failure, stay in select mode with exactly the documents that did
    // NOT delete still ticked, so the retry is one tap. Write the message after
    // render(), when the element it targets exists.
    const deleted = ids.length - failedIds.length;
    S.selectedInvs = failedIds;
    S.selectMode   = failedIds.length > 0;

    await loadUserData(uid);
    render();

    if (failedIds.length) {
      showErr('inv-del-err', deleted
        ? `${deleted} deleted. ${failedIds.length} could not be removed and ${failedIds.length === 1 ? 'is' : 'are'} still selected — please try again.`
        : `Could not delete ${failedIds.length === 1 ? 'that document' : 'those documents'} — please try again.`);
    }
    return;
  }

  if (action === 'markInvoicePaid') {
    const uid = S.user?.uid;
    if (!uid || !S.openInvId) return;
    try {
      await db.collection('users').doc(uid).collection('invoices').doc(S.openInvId)
        .update({ status: 'paid', paidAt: firebase.firestore.FieldValue.serverTimestamp() });
      await loadUserData(uid);
      render();
    } catch (err) {
      console.error('markInvoicePaid:', err);
    }
    return;
  }

  if (action === 'saveCustomerConsent') {
    const uid = S.user?.uid;
    if (!uid || !S.editCxId) return;
    const how = $('ecx-consent')?.value || '';
    if (!how) { showErr('ecx-err', 'Please select an option.'); return; }
    showErr('ecx-err', '');
    setBtn('ecx-save-btn', true, 'Save Permission');
    const consent = how !== 'none';
    try {
      await db.collection('users').doc(uid).collection('customers').doc(S.editCxId).update({
        smsConsent:       consent,
        smsConsentMethod: how,
        smsConsentScope:  consent ? 'all' : '',
        smsConsentAt:     firebase.firestore.FieldValue.serverTimestamp(),
        smsConsentBy:     S.user?.email || '',
        // Off unless the contractor is on Pro AND ticked the box. Withdrawing
        // texting permission withdraws the follow-up with it.
        reviewFollowUp:   consent && !!$('ecx-followup')?.checked,
      });
      await loadUserData(uid);
      nav('customers');
    } catch (err) {
      console.error('saveCustomerConsent:', err);
      showErr('ecx-err', 'Could not save - please try again.');
      setBtn('ecx-save-btn', false, 'Save Permission');
    }
    return;
  }

  if (action === 'saveCustomer') {
    const uid = S.user?.uid;
    if (!uid) return;
    // The form has a Save button after the required fields and another at the
    // bottom, so feedback has to reach whichever one the user is looking at.
    const cxErr = (msg) => { showErr('cx-err', msg); showErr('cx-err2', msg); };
    const cxBtn = (loading, label) => { setBtn('cx-save-btn', loading, label); setBtn('cx-save-btn2', loading, label); };
    const name  = $('cx-name')?.value?.trim();
    const phone = $('cx-phone')?.value?.trim();
    const addr  = $('cx-addr')?.value?.trim();
    const smsConsentHow = $('cx-consent-how')?.value || '';
    // 'none' is a deliberate, honest answer; empty is an unanswered required field.
    const smsConsent    = !!smsConsentHow && smsConsentHow !== 'none';
    if (!name || !phone || !addr) {
      cxErr('Please fill in all required fields (*).');
      return;
    }
    if (!smsConsentHow) {
      cxErr('Please select how this customer agreed to receive text messages.');
      return;
    }
    cxErr('');
    cxBtn(true, 'Save customer');
    try {
      await db.collection('users').doc(uid).collection('customers').add({
        name,
        phone,
        email:           $('cx-email')?.value?.trim() || '',
        address:         addr,
        address2:        $('cx-addr2')?.value?.trim() || '',
        billingName:     $('cx-billname')?.value?.trim() || '',
        billingAddress:  $('cx-billaddr')?.value?.trim() || '',
        paymentMethod:   $('cx-paymethod')?.value || '',
        paymentTerms:    $('cx-terms')?.value || '',
        acctCustomerId:  $('cx-acctid')?.value?.trim() || '',
        taxExempt:       !!$('cx-taxexempt')?.checked,
        // SMS consent attestation. smsConsent gates every automated text to this
        // customer (auto-forward, review requests) — see canTextCustomer() in the
        // functions. Method and timestamp are stored so consent is auditable.
        smsConsent:       smsConsent,
        smsConsentMethod: smsConsentHow,
        // 'all' = answered for this specific person, so it also covers review
        // requests. A bulk attestation records 'transactional' instead and
        // does not unlock review requests. See functions/lib/consent.mjs.
        smsConsentScope:  smsConsent ? 'all' : '',
        smsConsentAt:     smsConsent ? firebase.firestore.FieldValue.serverTimestamp() : null,
        smsConsentBy:     S.user?.email || '',
        // Explicit false rather than absent: review follow-up is opt-in, and a
        // missing field reads as undefined at three different call sites.
        // Turned on per customer from their profile, RelayPRO only.
        reviewFollowUp:   false,
        customerType:    $('cx-type')?.value || '',
        secondaryName:   $('cx-sec-name')?.value?.trim() || '',
        secondaryPhone:  $('cx-sec-phone')?.value?.trim() || '',
        accessNotes:     $('cx-access')?.value?.trim() || '',
        referralSource:  $('cx-referral')?.value?.trim() || '',
        notes:           $('cx-notes')?.value?.trim() || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      await loadUserData(uid);
      nav('customers');
    } catch (err) {
      console.error('saveCustomer:', err);
      cxErr('Failed to save customer — please try again.');
      cxBtn(false, 'Save Customer');
    }
    return;
  }

  // ── SAVE PROFILE ──
  if (action === 'saveProfile') {
    const uid = S.user?.uid;
    if (!uid) return;
    const co          = document.getElementById('pf-co')?.value?.trim()        || S.profile?.companyName || '';
    const plat        = document.getElementById('pf-platform')?.value          || 'none';
    const bizType     = document.getElementById('pf-biztype')?.value           || '';
    const bizTypeOther= document.getElementById('pf-biztype-other')?.value?.trim() || '';
    const license     = document.getElementById('pf-license')?.value?.trim()   || '';
    const callFee     = parseFloat(document.getElementById('pf-callFee')?.value) || 0;
    const taxRate     = parseFloat(document.getElementById('pf-tax')?.value)   || 0;
    const terms       = document.getElementById('pf-terms')?.value             || 'Due on receipt';
    const validity    = document.getElementById('pf-validity')?.value          || '30 days';
    const invPrefix   = document.getElementById('pf-invprefix')?.value?.trim() || '';
    const footer      = document.getElementById('pf-footer')?.value?.trim()    || '';
    const payMethodOther = document.getElementById('pf-pay-other-chk')?.checked
      ? (document.getElementById('pf-pay-other')?.value?.trim() || '') : '';
    const payMethods  = ['Cash','Check','Zelle','Venmo','CashApp','Credit / Debit Card']
      .filter(m => document.getElementById('pf-pay-'+m.replace(/[^a-z]/gi,'').toLowerCase())?.checked);
    const paymentUsernames = {};
    [['Zelle','zelle'],['Venmo','venmo'],['CashApp','cashapp'],['Credit / Debit Card','creditdebitcard']].forEach(([m,id]) => {
      const v = document.getElementById('pf-pay-user-'+id)?.value?.trim();
      if (v) paymentUsernames[m] = v;
    });
    const reviewUrl   = document.getElementById('pf-review-url')?.value?.trim() || '';
    const autoForwardToCustomer = document.getElementById('pf-autofwd')?.checked || false;
    const saveBtn = document.getElementById('pf-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      // The business phone identifies every inbound job text. Reject anything
      // that is not a usable number rather than saving junk that will never
      // match, which would fail silently at the worst possible moment.
      const phoneRaw = ($('pf-phone')?.value || '').trim();
      const phoneE164 = toE164(phoneRaw);
      if (!phoneE164) {
        showErr('pf-err', phoneRaw
          ? 'That does not look like a valid phone number. Use the number you text from, e.g. (616) 248-1977.'
          : 'Your business phone number is required — it is how Relay knows a job text is from you.');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; }
        return;
      }
      const updates = {
        phoneNumber: phoneE164, phoneDigits: phoneDigits(phoneE164), phone: phoneRaw,
        companyName: co, platform: plat, accountingProvider: plat,
        businessType: bizType, businessTypeOther: bizTypeOther,
        licenseNumber: license, minCallFee: callFee, taxRate: taxRate,
        paymentTerms: terms, estimateValidity: validity, invoicePrefix: invPrefix,
        invoiceFooter: footer, paymentMethods: payMethods, paymentMethodOther: payMethodOther,
        paymentUsernames,
      };
      const plan = (S.profile?.plan || '').toLowerCase();
      // Gate each field on its own feature. Both helpers are Pro-only today, but
      // the review link belongs to the review feature and auto-forward to its
      // own; sharing one guard means changing either tier silently changes both.
      // review-request.mjs reads users/{uid}.reviewUrl - keep that field name.
      if (canReviewRequest(plan)) {
        updates.reviewUrl = reviewUrl;
      }
      if (canAutoForward(plan)) {
        updates.autoForwardToCustomer = autoForwardToCustomer;
      }
      await db.collection('users').doc(uid).update(updates);
      S.profile = { ...S.profile, ...updates };
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Saved ✓'; setTimeout(() => { if (saveBtn) saveBtn.textContent = 'Save changes'; }, 2000); }
    } catch(err) {
      console.error('saveProfile:', err);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save failed — retry'; }
    }
    return;
  }

  // ── SIGN OUT ──
  if (action === 'signOut') {
    await auth.signOut();
    return;
  }

  // ── ADMIN ──
  if (action === 'goAdmin') {
    nav('admin');
    return;
  }
});

// ── BOOT ─────────────────────────────────────────────────────────────────

// Check for Stripe payment redirect signal
if (location.search.includes('payment=success') || location.hash.includes('payment=success')) {
  S._paymentReceived = true;
}

// Show loading immediately
$('app').innerHTML = sLoading();

// Firebase auth state — single source of truth for routing
// /signup must land directly on the opt-in form. Toll-free verification
// reviewers are given one URL and will not click through a single-page app to
// find the consent checkbox; an opt-in they cannot see is an opt-in that does
// not count.
function initialSignedOutScreen() {
  const p = (window.location.pathname || '').toLowerCase();
  return (p === '/signup' || p === '/signup/') ? 'signup' : 'login';
}

auth.onAuthStateChanged(async user => {
  if (!user) {
    S.user    = null;
    S.profile = null;
    nav(initialSignedOutScreen());
    return;
  }

  S.user = user;
  await loadUserData(user.uid);

  const isAdmin = user.email === ADMIN_EMAIL;
  const status  = S.profile?.subscriptionStatus;

  if (isAdmin) { nav('dashboard'); return; }

  // Active statuses that can access the portal
  const OPEN = new Set(['active', 'trialing', 'past_due']);

  if (OPEN.has(status)) {
    nav('dashboard');
  } else {
    // unpaid, canceled, suspended → locked screen
    nav('locked');
  }
});
// ── Document Template Upload ────────────────────────────────────────────────
async function handleTemplateUpload(input) {
  const file = input.files[0];
  const status = document.getElementById("f-template-status");
  if (!file) return;

  const allowed = ["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  if (!allowed.includes(file.type)) {
    status.textContent = "Please upload a PDF or Word document.";
    status.style.color = "#e53e3e";
    return;
  }

  // Template upload via Firebase Storage — coming soon
  status.textContent = "Template upload coming soon.";
  status.style.color = "#718096";
}

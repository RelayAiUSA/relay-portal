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
const STRIPE_STARTER  = 'https://buy.stripe.com/REPLACE_STARTER_LINK';
const STRIPE_PRO      = 'https://buy.stripe.com/REPLACE_PRO_LINK';
const STRIPE_BILLING  = 'https://billing.stripe.com/p/login/REPLACE_PORTAL_LINK';

// Protected screens — require active subscription
const PROTECTED = new Set(['dashboard','submit','invoices','customers','profile']);

// ── STATE ─────────────────────────────────────────────────────────────────

const S = {
  screen:   'loading',
  filter:   'all',
  search:   '',
  formType: 'invoice',
  formPrice:'flat',
  lastJob:  null,
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
  bell:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
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

function badge(status) {
  const map = {paid:'paid',sent:'sent',overdue:'overdue',quote:'quote',pending:'pending'};
  const lbl = {paid:'Paid',sent:'Sent',overdue:'Overdue',quote:'Quote',pending:'Pending'};
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
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
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
    const [profSnap, invSnap, cxSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('invoices').get(),
      db.collection('users').doc(uid).collection('customers').get(),
    ]);

    S.profile = profSnap.exists ? profSnap.data() : {
      companyName: S.user.displayName || 'My Company',
      plan: 'Starter',
      platform: 'quickbooks',
      laborRate: 100,
      materialMarkup: 15,
      paymentTerms: 'Due on receipt',
    };

    S.invoices = invSnap.docs
      .map(d => ({docId: d.id, ...d.data()}))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    S.customers = cxSnap.docs.map(d => ({docId: d.id, ...d.data()}));
  } catch(e) {
    console.error('loadUserData:', e);
    if (!S.profile) S.profile = {companyName: 'My Company', plan: 'Starter', platform: 'quickbooks'};
    S.invoices  = S.invoices  || [];
    S.customers = S.customers || [];
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
    {id:'submit',    ic:I.plus,     lbl:'Submit'},
    {id:'invoices',  ic:I.file,     lbl:'Invoices'},
    {id:'customers', ic:I.users,    lbl:'Customers'},
  ];
  return `<nav class="tabs">${t.map(x=>`
    <button class="tab${active===x.id?' on':''}" data-nav="${x.id}">${x.ic}${x.lbl}</button>`).join('')}</nav>`;
}

function topbar({title, sub='', back='', light=false, right=''}) {
  return `<header class="topbar${light?' light':''}">
    ${back
      ? `<button class="back-btn${light?' dark':''}" data-nav="${back}" aria-label="Back">${I.back}</button>`
      : `<div class="topbar-logo">R</div>`}
    <div style="flex:1">
      <div class="topbar-title">${title}</div>
      ${sub ? `<div class="topbar-sub">${sub}</div>` : ''}
    </div>
    ${right}
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
    <div id="lg-err" class="auth-error" style="display:none"></div>
    <div class="form-group">
      <label class="form-lbl" for="lg-email">Email</label>
      <input id="lg-email" type="email" class="input" placeholder="you@yourbusiness.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-lbl" for="lg-pw">Password</label>
      <input id="lg-pw" type="password" class="input" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button id="lg-btn" class="btn btn-primary" data-action="login" style="margin-bottom:8px">Sign in to Relay</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Continue with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="signup">New to Relay? Create an account →</button>
    </div>
  </main>`;
}

function sSignup() {
  return `<main class="login-wrap">
    <div class="relay-mark"><span>R</span></div>
    <h1 class="login-title">Create your account</h1>
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
      <label class="form-lbl">Accounting software</label>
      <select id="sg-platform" class="input">
        <option value="quickbooks">QuickBooks Online</option>
        <option value="zoho">Zoho Books</option>
        <option value="none">I'll set this up later</option>
      </select>
    </div>
    <button id="sg-btn" class="btn btn-primary" data-action="signup" style="margin-bottom:8px">Create my Relay account</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Sign up with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="login">Already have an account? Sign in →</button>
    </div>
  </main>`;
}

function sLocked() {
  const status  = S.profile?.subscriptionStatus || 'unpaid';
  const name    = S.profile?.companyName || 'there';
  const paid    = S._paymentReceived;

  // ── banner copy per status ──────────────────────────────────────────────
  const BANNERS = {
    unpaid: {
      icon:  '🚀',
      accent: 'var(--brand)',
      title: "You're one step away from going live",
      msg:   `Hey ${name} — your Relay portal is built and ready. Add your subscription to start submitting jobs, dispatching invoices, and building your customer registry.`,
      perks: ['100 invoices created, dispatched & tracked monthly','SMS job submission via +1 (844) 729-1376','Auto payment reminders at 72 hrs overdue','Client portal with live invoice status','QuickBooks & Zoho Books sync'],
      cta:   'Activate — Starter $49/mo',
      ctaHref: STRIPE_STARTER,
      alt:   'Need more? See Pro at $99/mo →',
      altHref: STRIPE_PRO,
    },
    past_due: {
      icon:  '⚠️',
      accent: '#b45309',
      title: 'Your account is temporarily on hold',
      msg:   "We weren't able to process your last payment. Your invoices, customers, and history are all safe — update your payment method to restore full access in seconds.",
      perks: [],
      cta:   'Update payment method →',
      ctaHref: STRIPE_BILLING,
      alt:   'Questions? Text us at +1 (844) 729-1376',
      altHref: null,
    },
    canceled: {
      icon:  '📋',
      accent: '#dc2626',
      title: 'Your Relay subscription has ended',
      msg:   'Your dispatch portal is currently inactive. Reactivate your subscription to get back online — every invoice, customer record, and job history is saved and waiting for you.',
      perks: [],
      cta:   'Reactivate — Starter $49/mo',
      ctaHref: STRIPE_STARTER,
      alt:   'See Pro plan ($99/mo) →',
      altHref: STRIPE_PRO,
    },
    suspended: {
      icon:  '🔒',
      accent: '#dc2626',
      title: 'Your account has been suspended',
      msg:   'Access to your Relay portal has been suspended. Please contact Relay support to resolve this — your data is safe.',
      perks: [],
      cta:   'Contact Relay support',
      ctaHref: 'mailto:support@relay.io',
      alt:   null,
      altHref: null,
    },
  };

  const b = BANNERS[status] || BANNERS.unpaid;

  return `<div class="locked-wrap">
    <div class="locked-top">
      <div class="relay-mark"><span>R</span></div>
      <button class="link-btn" data-action="signOut" style="font-size:13px;color:#9ca3af">Sign out</button>
    </div>

    ${paid ? `<div class="payment-received-banner">
      <span style="font-size:18px">✅</span>
      <div>
        <div style="font-weight:600;font-size:14px">Payment received — thank you!</div>
        <div style="font-size:12px;opacity:.85;margin-top:2px">Your account will be activated shortly. Refresh this page in a minute.</div>
      </div>
    </div>` : ''}

    <div class="locked-icon">${b.icon}</div>
    <h2 class="locked-title">${b.title}</h2>
    <p class="locked-msg">${b.msg}</p>

    ${b.perks.length ? `<div class="locked-perks">
      ${b.perks.map(p=>`<div class="locked-perk">${I.check}<span>${p}</span></div>`).join('')}
    </div>` : ''}

    <a href="${b.ctaHref}" target="_blank" rel="noopener"
       class="btn btn-primary locked-cta"
       style="background:${b.accent};margin-bottom:10px">
      ${b.cta}
    </a>

    ${b.alt ? (b.altHref
      ? `<a href="${b.altHref}" target="_blank" rel="noopener" class="link-btn" style="display:block;text-align:center;font-size:13px;color:#6b7280">${b.alt}</a>`
      : `<p style="text-align:center;font-size:13px;color:#9ca3af;margin-top:4px">${b.alt}</p>`)
    : ''}

    <div class="locked-footer">
      <p style="font-size:12px;color:#9ca3af;text-align:center;line-height:1.6">
        Billed securely via Stripe · Cancel anytime<br>
        Questions? Text <strong>+1 (844) 729-1376</strong>
      </p>
    </div>
  </div>`;
}

function sPlans() {
  const plans = [
    {name:'Starter',price:'$49',per:'/mo',feats:['100 invoices created, dispatched, and tracked monthly','SMS job submission via text','Auto customer reminders','72-hr overdue alerts','Client portal access'],cta:'Get started',featured:false},
    {name:'Pro',price:'$99',per:'/mo',feats:['Everything in Starter','Receipt & expense tracking','Google review follow-ups','Prism analytics dashboard','Priority dispatch queue','QuickBooks + Zoho sync'],cta:'Start free trial',featured:true},
    {name:'Enterprise',price:'Custom',per:'',feats:['Multiple operators & crews','White-label portal','Dedicated account manager','API access','Custom integrations'],cta:'Contact sales',featured:false},
  ];
  return topbar({title:'Choose your plan', back:'signup'}) +
    `<div class="scroll">
      <p style="font-size:13px;color:#6b7280;margin-bottom:14px">Billed directly via Stripe — no app store cut. Cancel anytime.</p>
      ${plans.map(p=>`
        <div class="plan-card${p.featured?' featured':''}">
          ${p.featured?`<div style="margin-bottom:8px"><span class="badge paid">Most popular</span></div>`:''}
          <div class="plan-name">${p.name}</div>
          <div class="plan-price">${p.price}<span>${p.per}</span></div>
          <div class="plan-feat">
            ${p.feats.map(f=>`<div class="plan-feat-item">${I.check}${f}</div>`).join('')}
          </div>
          <button class="btn btn-primary${p.featured?'':' btn-outline'}" style="margin-top:12px" data-nav="signup">${p.cta}</button>
        </div>`).join('')}
      <div style="height:16px"></div>
    </div>`;
}

function sDashboard() {
  const name = S.profile?.companyName || 'My Company';
  const plan = S.profile?.plan        || 'Starter';
  const invs = S.invoices || [];

  // This-month stats
  const now   = new Date();
  const mo    = now.getMonth();
  const yr    = now.getFullYear();
  const mtd   = invs.filter(i => {
    const d = i.createdAt?.toDate ? i.createdAt.toDate() : new Date(i.createdAt || 0);
    return d.getMonth() === mo && d.getFullYear() === yr;
  });

  const revenue = mtd.filter(i => i.status === 'paid').reduce((s, i) => s + (i.amount || 0), 0);
  const sent    = mtd.filter(i => ['sent','paid','overdue'].includes(i.status)).length;
  const overdue = invs.filter(i => i.status === 'overdue').length;
  const recent  = invs.slice(0, 4);
  const isAdmin = S.user?.email === ADMIN_EMAIL;

  const subStatus = S.profile?.subscriptionStatus || 'unpaid';
  const trialBanner = (!isAdmin && subStatus === 'trialing') ? `
    <div class="trial-banner">
      <span style="font-size:18px">⏳</span>
      <div style="flex:1">
        <div class="trial-banner-title">Your free trial is active</div>
        <div class="trial-banner-sub">Subscribe before your trial ends to keep full access — no interruption.</div>
      </div>
      <a href="${STRIPE_STARTER}" target="_blank" rel="noopener" class="trial-banner-btn">Subscribe →</a>
    </div>` : '';

  return topbar({title: name, sub: `${plan} Plan · Active`, right:`
    ${isAdmin ? `<button class="topbar-btn" data-action="goAdmin" title="Admin view">${I.shield}</button>` : ''}
    <button class="topbar-btn" title="Notifications">${I.bell}</button>`}) +
  `<div class="scroll">${trialBanner}
    <p class="sh">This month</p>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-lbl">Revenue collected</div><div class="stat-val g">${fmt(revenue)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Invoices sent</div><div class="stat-val">${sent}</div></div>
      <div class="stat-card"><div class="stat-lbl">Overdue</div><div class="stat-val${overdue > 0 ? ' r' : ''}">${overdue}</div></div>
      <div class="stat-card"><div class="stat-lbl">All invoices</div><div class="stat-val">${invs.length}</div></div>
    </div>
    <p class="sh">Dispatch number</p>
    <div class="dispatch-number">
      <div class="dispatch-number-label">Relay SMS dispatch line</div>
      <div class="dispatch-number-val">+1 (844) 729-1376</div>
      <div class="dispatch-number-sub">Text job info to this number anytime — Invoice or Quote, customer name &amp; phone, address, work done, amount.</div>
    </div>
    <p class="sh">Quick actions</p>
    <div class="actions-grid">
      <div class="action-item" data-nav="submit"><div class="action-icon">${I.send}</div><div class="action-lbl">Submit job</div><div class="action-desc">Invoice or quote</div></div>
      <div class="action-item" data-nav="invoices"><div class="action-icon">${I.file}</div><div class="action-lbl">My invoices</div><div class="action-desc">Track &amp; status</div></div>
      <div class="action-item" data-nav="customers"><div class="action-icon">${I.users}</div><div class="action-lbl">Customers</div><div class="action-desc">Registry</div></div>
      <div class="action-item" data-nav="profile"><div class="action-icon">${I.settings}</div><div class="action-lbl">Profile</div><div class="action-desc">Rates &amp; settings</div></div>
    </div>
    <p class="sh">Recent activity</p>
    <div class="card">
      ${recent.length
        ? recent.map(inv => {
            const dot = inv.status==='paid' ? '#16a34a'
                      : inv.status==='overdue' ? '#dc2626'
                      : inv.status==='sent' ? '#2563eb' : '#6366f1';
            return `<div class="act-item">
              <div class="act-dot" style="background:${dot}"></div>
              <div>
                <div class="act-title">${inv.type==='quote'?'Quote':'Invoice'} ${badge(inv.status)} — ${fmt(inv.amount||0)}</div>
                <div class="act-sub">${inv.customer} · ${fmtDate(inv.createdAt)}</div>
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:28px;text-align:center;color:#9ca3af;font-size:14px">
            <div style="font-size:32px;margin-bottom:10px">🚀</div>
            <div style="font-weight:600;color:#374151;margin-bottom:4px">You're all set!</div>
            <div>Submit your first job to get started.</div>
          </div>`
      }
    </div>
  </div>
  ${tabs('dashboard')}`;
}

function sSubmit() {
  return topbar({title: 'New job submission', back: 'dashboard'}) +
  `<div class="scroll">
    <p class="sh">Job type <span class="req">*</span></p>
    <div class="toggle-g">
      <button class="toggle-btn${S.formType==='invoice'?' on':''}" data-toggle="type" data-val="invoice">${I.file} Invoice</button>
      <button class="toggle-btn${S.formType==='quote'?' on':''}" data-toggle="type" data-val="quote">${I.file} Quote</button>
    </div>
    <p class="sh">Customer info</p>
    <div class="form-group"><label class="form-lbl" for="f-name">Customer name <span class="req">*</span></label><input id="f-name" type="text" class="input" placeholder="e.g. Jeff Smith" autocomplete="off"></div>
    <div class="form-group"><label class="form-lbl" for="f-phone">Customer phone <span class="req">*</span></label><input id="f-phone" type="tel" class="input" placeholder="(616) 248-1977"></div>
    <div class="form-group"><label class="form-lbl" for="f-email">Customer email</label><input id="f-email" type="email" class="input" placeholder="optional — for invoice delivery"></div>
    <p class="sh">Job details</p>
    <div class="form-group"><label class="form-lbl" for="f-addr">Job address <span class="req">*</span></label><input id="f-addr" type="text" class="input" placeholder="412 Oak St, Grand Rapids MI" autocomplete="off"></div>
    <div class="form-group"><label class="form-lbl" for="f-work">Work description <span class="req">*</span></label><textarea id="f-work" class="input" placeholder="Describe what was done in 2–3 sentences.&#10;e.g. Removed and replaced water heater, installed new supply valve."></textarea></div>
    <p class="sh">Pricing</p>
    <div class="toggle-g">
      <button class="toggle-btn${S.formPrice==='flat'?' on':''}" data-toggle="price" data-val="flat">Flat rate</button>
      <button class="toggle-btn${S.formPrice==='itemized'?' on':''}" data-toggle="price" data-val="itemized">Materials + labor</button>
    </div>
    ${S.formPrice === 'flat'
      ? `<div class="form-group"><label class="form-lbl" for="f-total">Total amount <span class="req">*</span></label><input id="f-total" type="text" class="input" placeholder="$0.00"></div>`
      : `<div class="input-row">
          <div class="form-group"><label class="form-lbl" for="f-mat">Materials</label><input id="f-mat" type="text" class="input" placeholder="$0.00"></div>
          <div class="form-group"><label class="form-lbl" for="f-lab">Labor</label><input id="f-lab" type="text" class="input" placeholder="3 hrs @ $100"></div>
        </div>`}
    <div class="form-group"><label class="form-lbl" for="f-notes">Special notes</label><input id="f-notes" type="text" class="input" placeholder="e.g. Address invoice to property manager"></div>
    <p class="sh">Photos (optional)</p>
    <div class="upload-area">${I.camera}<div style="font-size:13px;color:#6b7280">Tap to add photos</div><div style="font-size:11px;color:#9ca3af;margin-top:3px">Before/after work</div></div>
    <div id="sub-err" class="auth-error" style="display:none;margin-bottom:10px"></div>
    <button id="sub-btn" class="btn btn-primary" data-action="submitJob">Send to Relay dispatch</button>
    <div style="height:20px"></div>
  </div>
  ${tabs('submit')}`;
}

function sConfirm() {
  const j = S.lastJob || {type:'invoice', customer:'Customer', amount:'$0'};
  return `<div class="confirm-wrap">
    <div class="confirm-icon">${I.check}</div>
    <h2 class="confirm-title">Job submitted!</h2>
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
    <button class="btn btn-primary" data-nav="dashboard" style="margin-bottom:10px">Back to dashboard</button>
    <button class="btn btn-outline" data-nav="submit">Submit another job</button>
  </div>`;
}

function sInvoices() {
  const invs    = S.invoices || [];
  const filters = ['all','pending','sent','overdue','paid','quote'];
  const list    = S.filter === 'all' ? invs : invs.filter(i => i.status === S.filter);

  return topbar({title:'Invoices', sub:`${invs.length} total`, right:`<button class="topbar-btn">${I.bell}</button>`}) +
  `<div class="filter-row">
    ${filters.map(f=>`<button class="fp${S.filter===f?' on':''}" data-filter="${f}">${f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
  </div>
  <div class="scroll" style="padding:12px 16px">
    <div class="card">
      ${list.length
        ? list.map(inv => {
            const ini  = getInitials(inv.customer || '?');
            const work = (inv.work || '').slice(0, 34);
            return `<div class="inv-item">
              <div class="inv-av">${ini}</div>
              <div class="inv-info">
                <div class="inv-name">${inv.customer || 'Unknown'}</div>
                <div class="inv-meta">${work}${(inv.work||'').length > 34 ? '…' : ''} · ${fmtDate(inv.createdAt)}</div>
              </div>
              <div class="inv-right">
                <div class="inv-amt">${fmt(inv.amount || 0)}</div>
                <div style="margin-top:4px">${badge(inv.status || 'pending')}</div>
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">
            ${S.filter==='all' ? 'No invoices yet — submit your first job!' : 
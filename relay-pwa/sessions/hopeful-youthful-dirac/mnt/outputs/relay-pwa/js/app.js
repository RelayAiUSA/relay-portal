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

// ── ZOHO OAUTH ────────────────────────────────────────────────────────────
const ZOHO_CLIENT_ID    = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
const ZOHO_REDIRECT_URI = 'https://portal-relay.com/.netlify/functions/zoho-callback';
const ZOHO_SCOPES       = 'ZohoBooks.contacts.ALL,ZohoBooks.invoices.ALL,ZohoBooks.estimates.ALL,ZohoBooks.settings.READ';

function startZohoConnect() {
  const uid = auth.currentUser?.uid;
  if (!uid) { alert('Please sign in first.'); return; }
  const params = new URLSearchParams({
    scope:         ZOHO_SCOPES,
    client_id:     ZOHO_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  ZOHO_REDIRECT_URI,
    access_type:   'offline',
    state:         uid           // passed back in callback so we know which user
  });
  window.location.href = `https://accounts.zoho.com/oauth/v2/auth?${params}`;
}

// ── QUICKBOOKS OAUTH ──────────────────────────────────────────────────────
const QB_CLIENT_ID    = 'ABvGiOklSSgKZ79AxonQxvCODXLkuHbFIJkeTZtrmJlQPGGflp';
const QB_REDIRECT_URI = 'https://portal-relay.com/.netlify/functions/quickbooks-callback';
const QB_SCOPES       = 'com.intuit.quickbooks.accounting';

function startQuickBooksConnect() {
  const uid = auth.currentUser?.uid;
  if (!uid) { alert('Please sign in first.'); return; }
  const params = new URLSearchParams({
    client_id:     QB_CLIENT_ID,
    scope:         QB_SCOPES,
    redirect_uri:  QB_REDIRECT_URI,
    response_type: 'code',
    access_type:   'offline',
    state:         uid
  });
  window.location.href = `https://appcenter.intuit.com/connect/oauth2?${params}`;
}

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

function topbar({title, sub='', back='', light=false, right='', logo=false}) {
  const leftSlot = back
    ? `<button class="back-btn${light?' dark':''}" data-nav="${back}" aria-label="Back">${I.back}</button>`
    : `<div class="topbar-logo">R</div>`;
  return `<header class="topbar${light?' light':''}">
    ${leftSlot}
    <div style="flex:1">
      <div class="topbar-title">${title}</div>
      ${sub ? `<div class="topbar-sub">${sub}</div>` : ''}
    </div>
    ${right}
  </header>`;
}

// ── SCREENS ───────────────────────────────────────────────────────────────

function sLoading() {
  return `<div class="splash-screen" style="animation:none">
    <div class="splash-content">
      <div class="splash-logo-ring"><span class="splash-logo-letter">R</span></div>
      <div class="splash-brand">Relay <span class="splash-ai">Ai</span></div>
      <div class="splash-tagline">Automated Dispatch &amp; Invoicing</div>
      <div class="splash-spinner-wrap"><div class="splash-spin"></div></div>
    </div>
  </div>`;
}

function sLogin() {
  return `<div class="auth-screen">
    <div class="auth-header">
      <div class="auth-logo-ring"><span class="splash-logo-letter">R</span></div>
      <div class="auth-brand">Relay <span class="splash-ai">Ai</span></div>
      <div class="auth-portal-label">Dispatching &amp; Invoicing Portal</div>
      <div class="auth-welcome">Welcome Back!</div>
    </div>
    <main class="auth-card">
      <p class="login-sub" style="margin-bottom:20px">Sign in to your Relay Ai portal.</p>
      <div id="lg-err" class="auth-error" style="display:none"></div>
      <div class="form-group">
        <label class="form-lbl" for="lg-email">Email</label>
        <input id="lg-email" type="email" class="input" placeholder="you@yourbusiness.com" autocomplete="email">
      </div>
      <div class="form-group">
        <label class="form-lbl" for="lg-pw">Password</label>
        <input id="lg-pw" type="password" class="input" placeholder="••••••••" autocomplete="current-password">
      </div>
      <button id="lg-btn" class="btn btn-primary" data-action="login" style="margin-bottom:8px">Sign in to Relay Ai</button>
      <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
      <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
        ${I.google} Continue with Google
      </button>
      <div style="margin-top:auto;padding-top:24px;text-align:center">
        <button class="link-btn" data-nav="signup">New to Relay Ai? Create an account →</button>
      </div>
    </main>
  </div>`;
}

function sSignup() {
  return `<div class="auth-screen">
    <div class="auth-header">
      <div class="auth-logo-ring"><span class="splash-logo-letter">R</span></div>
      <div class="auth-brand">Relay <span class="splash-ai">Ai</span></div>
      <div class="auth-portal-label">Dispatching &amp; Invoicing Portal</div>
      <div class="auth-welcome">Create Your Account</div>
    </div>
    <main class="auth-card">
      <p class="login-sub" style="margin-bottom:20px">Join the Relay Ai network. Your portal is ready immediately.</p>
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
      <button id="sg-btn" class="btn btn-primary" data-action="signup" style="margin-bottom:8px">Create my Relay Ai account</button>
      <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
      <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
        ${I.google} Sign up with Google
      </button>
      <div style="margin-top:auto;padding-top:24px;text-align:center">
        <button class="link-btn" data-nav="login">Already have an account? Sign in →</button>
      </div>
    </main>
  </div>`;
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
  const recent  = invs.slice(0, 3);
  const isAdmin = S.user?.email === ADMIN_EMAIL;

  const subStatus = S.profile?.subscriptionStatus || 'unpaid';
  const isActive  = isAdmin || subStatus === 'active' || subStatus === 'trialing';

  let payBanner = '';
  if (!isAdmin) {
    if (S._paymentReceived || subStatus === 'pending_approval') {
      payBanner = `<div class="pay-banner pay-pending">
        <span style="font-size:20px">⏳</span>
        <div style="flex:1">
          <div class="pay-banner-title">Payment received — awaiting approval</div>
          <div class="pay-banner-sub">We're reviewing your account. You'll receive access within 1 business day. Questions? Text us at +1 (844) 729-1376.</div>
        </div>
      </div>`;
    } else if (subStatus === 'unpaid') {
      payBanner = `<div class="pay-banner pay-required">
        <span style="font-size:20px">🔴</span>
        <div style="flex:1">
          <div class="pay-banner-title">Activate your account to start dispatching</div>
          <div class="pay-banner-sub">Choose a plan below to unlock the Relay dispatch line and start sending invoices automatically.</div>
          <div class="pay-banner-plans">
            <a href="${STRIPE_STARTER}" target="_blank" rel="noopener" class="pay-plan-btn pay-plan-starter">Starter — $49/mo</a>
            <a href="${STRIPE_PRO}" target="_blank" rel="noopener" class="pay-plan-btn pay-plan-pro">Pro — $99/mo</a>
          </div>
        </div>
      </div>`;
    } else if (subStatus === 'past_due') {
      payBanner = `<div class="pay-banner pay-pastdue">
        <span style="font-size:20px">⚠️</span>
        <div style="flex:1">
          <div class="pay-banner-title">Payment past due — dispatch paused</div>
          <div class="pay-banner-sub">Update your billing to restore full access to the dispatch line.</div>
          <a href="${STRIPE_BILLING}" target="_blank" rel="noopener" class="pay-plan-btn pay-plan-starter" style="margin-top:10px;display:inline-block">Update billing →</a>
        </div>
      </div>`;
    } else if (subStatus === 'trialing') {
      payBanner = `<div class="pay-banner pay-trial">
        <span style="font-size:20px">⏳</span>
        <div style="flex:1">
          <div class="pay-banner-title">Your free trial is active</div>
          <div class="pay-banner-sub">Subscribe before your trial ends to keep full access.</div>
        </div>
        <a href="${STRIPE_STARTER}" target="_blank" rel="noopener" class="trial-banner-btn">Subscribe →</a>
      </div>`;
    }
  }

  const statusLabel = isAdmin ? 'Admin' : subStatus === 'active' ? 'Active' : subStatus === 'trialing' ? 'Trial' : 'Pending activation';

  return topbar({title: name, sub: `${plan} · ${statusLabel}`, logo: true, right:`
    ${isAdmin ? `<button class="topbar-btn" data-action="goAdmin" title="Admin view">${I.shield}</button>` : ''}
    <button class="topbar-btn" data-nav="profile" title="Account settings">${I.settings}</button>`}) +
  `<div class="scroll">${payBanner}
    <p class="sh">This month</p>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-lbl">Revenue collected</div><div class="stat-val g">${fmt(revenue)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Invoices sent</div><div class="stat-val">${sent}</div></div>
      <div class="stat-card"><div class="stat-lbl">Overdue</div><div class="stat-val${overdue > 0 ? ' r' : ''}">${overdue}</div></div>
      <div class="stat-card"><div class="stat-lbl">All invoices</div><div class="stat-val">${invs.length}</div></div>
    </div>
    <p class="sh">Dispatch number</p>
    ${isActive ? `<div class="dispatch-number">
      <div class="dispatch-number-label">Relay SMS dispatch line</div>
      <div class="dispatch-number-val">+1 (844) 729-1376</div>
      <div class="dispatch-number-sub">TEXT job info to this number ANYTIME!<br><br>
        1. Invoice OR Quote<br>
        2. Customer Name, Phone Number, &amp; Address<br>
        3. Task/Job to be billed (brief detail please)<br>
        4. Price/Amount to be billed $$$ (flat rate OR materials+labor)
      </div>
    </div>` : `<div class="dispatch-number dispatch-locked">
      <div class="dispatch-number-label">Relay SMS dispatch line</div>
      <div class="dispatch-number-val locked-blur">+1 (844) 729-1376</div>
      <div class="dispatch-number-sub">🔒 Activate your account to unlock the dispatch line.</div>
    </div>`}
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
            <div style="font-size:32px;margin-bottom:10px">📋</div>
            <div style="font-weight:600;color:#374151;margin-bottom:4px">No jobs yet</div>
            <div>Text your first job to the dispatch line above to get started.</div>
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
          'No invoices in this category'}
        </div>`
    }
    </div>
  </div>
  ${tabs('invoices')}`;
}

function sCustomers() {
  const cx   = S.customers || [];
  const q    = S.search.toLowerCase();
  const list = q ? cx.filter(c => (c.name||'').toLowerCase().includes(q) || (c.phone||'').includes(q)) : cx;

  return topbar({title:'Customers', sub:`${cx.length} contact${cx.length!==1?'s':''}`, right:`<button class="topbar-btn" style="font-size:22px;line-height:1" title="Add">+</button>`}) +
  `<div class="search-wrap">
    <input id="cx-search" type="search" class="search-input" placeholder="Search customers…" value="${S.search}" autocomplete="off">
  </div>
  <div class="scroll" style="padding:12px 16px">
    <div class="card" id="cx-list">
      ${cxRows(list)}
    </div>
  </div>
  ${tabs('customers')}`;
}

function cxRows(list) {
  if (!list.length) {
    return `<div style="padding:28px;text-align:center;color:#9ca3af;font-size:14px">
      ${S.search ? 'No customers match your search' : 'No customers yet — they appear automatically when you submit jobs'}
    </div>`;
  }
  return list.map(c => {
    const col = avatarColor(c.name || '');
    const ini = getInitials(c.name || '?');
    return `<div class="cx-item">
      <div class="cx-av" style="background:${col.bg};color:${col.fg}">${ini}</div>
      <div>
        <div class="cx-name">${c.name || 'Unknown'}</div>
        <div class="cx-sub">${c.phone || ''} · ${c.jobs || 0} job${(c.jobs||0)!==1?'s':''}</div>
      </div>
      <div class="cx-right">
        ${(c.owed||0) > 0
          ? `<span class="badge overdue">Owes ${fmt(c.owed)}</span>`
          : `<span class="badge paid">${fmt(c.total||0)}</span>`}
      </div>
    </div>`;
  }).join('');
}

function sProfile() {
  const p    = S.profile || {};
  const name = p.companyName || '';
  const ini  = getInitials(name || 'My Company');
  const plan = p.plan     || 'Starter';
  const plat = p.platform || 'quickbooks';
  const subStatus = p.subscriptionStatus || 'unpaid';
  const isAdmin   = S.user?.email === ADMIN_EMAIL;

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const renewStr = months[(now.getMonth()+1)%12] + ' ' + now.getDate();
  const subBadge = subStatus === 'active' ? `<span class="badge paid">Active</span>`
                 : subStatus === 'trialing' ? `<span class="badge quote">Trial</span>`
                 : subStatus === 'past_due' ? `<span class="badge overdue">Past due</span>`
                 : `<span class="badge pending">Pending</span>`;

  const platLabel = plat === 'quickbooks' ? 'QuickBooks Online'
                  : plat === 'zoho' ? 'Zoho Books' : 'Not connected';

  return topbar({title:'Account & Settings', back:'dashboard'}) +
  `<div class="scroll" style="padding:0">

    <!-- ── Profile header ── -->
    <div class="prof-head">
      <div class="prof-av">${ini}</div>
      <div style="font-size:17px;font-weight:700;color:#0d1b2a">${name || 'Set your company name below'}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:3px">${plan} Plan · ${S.user?.email||''}</div>
    </div>

    <div style="padding:16px">

      <!-- ── 1. Business Info ── -->
      <div class="prof-section-label">
        <span class="prof-section-num">1</span> Business Info
      </div>
      <div class="card card-p" style="margin-bottom:18px">
        <div class="form-group">
          <label class="form-lbl">Company / DBA name</label>
          <input type="text" class="input" id="pf-name" value="${name}" placeholder="e.g. Hartwell Contracting">
        </div>
        <div class="form-group">
          <label class="form-lbl">Default payment terms</label>
          <select class="input" id="pf-terms">
            ${['Due on receipt','Net 7','Net 14','Net 30'].map(t=>`<option value="${t}"${t===(p.paymentTerms||'Due on receipt')?' selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-lbl">Business phone number (for SMS invoicing)</label>
          <input type="tel" class="input" id="pf-phone" value="${p.businessPhone||''}"
                 placeholder="e.g. +12145550192"
                 style="font-size:15px;letter-spacing:0.5px">
          <div style="font-size:11px;color:#6b7280;margin-top:4px;line-height:1.5">
            This is the number you'll text from to create invoices. Include country code (e.g. +1).
          </div>
        </div>
      </div>

      <!-- ── 2. Rate Defaults ── -->
      <div class="prof-section-label">
        <span class="prof-section-num">2</span> Rate Defaults
      </div>
      <div class="card card-p" style="margin-bottom:18px">
        <div class="prof-rate-hint">These defaults pre-fill your job submissions. You can always override per job.</div>
        <div class="input-row">
          <div class="form-group">
            <label class="form-lbl">Labor rate / hr ($)</label>
            <input type="number" class="input" id="pf-labor" value="${p.laborRate||100}" placeholder="100" min="0" step="5">
          </div>
          <div class="form-group">
            <label class="form-lbl">Material markup (%)</label>
            <input type="number" class="input" id="pf-markup" value="${p.materialMarkup||15}" placeholder="15" min="0" max="100" step="1">
          </div>
        </div>
      </div>

      <!-- ── 3. Accounting Software ── -->
      <div class="prof-section-label">
        <span class="prof-section-num">3</span> Accounting Software
      </div>
      <div class="card card-p" style="margin-bottom:18px">
        <p style="font-size:13px;color:#6b7280;margin:0 0 14px;line-height:1.5">
          Select the platform you use so Relay Ai can send invoices and quotes directly into your accounting software.
        </p>
        <div class="plat-options">
          <!-- QuickBooks -->
          <label class="plat-opt${plat==='quickbooks'?' plat-sel':''}">
            <input type="radio" name="pf-plat" value="quickbooks"${plat==='quickbooks'?' checked':''} style="display:none">
            <div class="plat-opt-icon" style="background:#2CA01C">QB</div>
            <div style="flex:1">
              <div class="plat-opt-name">QuickBooks Online</div>
              <div class="plat-opt-sub">Intuit · Most popular</div>
            </div>
            ${S.profile?.quickbooks?.connected
              ? `<span style="font-size:11px;color:#16a34a;font-weight:600;background:#dcfce7;padding:3px 8px;border-radius:20px">✓ Connected</span>`
              : `<button onclick="startQuickBooksConnect()" style="font-size:12px;font-weight:600;color:#fff;background:#2CA01C;border:none;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap">Connect →</button>`}
          </label>

          <!-- Zoho Books -->
          <label class="plat-opt${plat==='zoho'?' plat-sel':''}">
            <input type="radio" name="pf-plat" value="zoho"${plat==='zoho'?' checked':''} style="display:none">
            <div class="plat-opt-icon" style="background:#E42527">Z</div>
            <div style="flex:1">
              <div class="plat-opt-name">Zoho Books</div>
              <div class="plat-opt-sub">Zoho · Great for small teams</div>
            </div>
            ${S.profile?.zoho?.connected
              ? `<span style="font-size:11px;color:#16a34a;font-weight:600;background:#dcfce7;padding:3px 8px;border-radius:20px">✓ Connected</span>`
              : `<button onclick="startZohoConnect()" style="font-size:12px;font-weight:600;color:#fff;background:#E42527;border:none;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap">Connect →</button>`}
          </label>

          <!-- No connection -->
          <label class="plat-opt${plat==='none'?' plat-sel':''}">
            <input type="radio" name="pf-plat" value="none"${plat==='none'?' checked':''} style="display:none">
            <div class="plat-opt-icon" style="background:#6b7280">—</div>
            <div style="flex:1">
              <div class="plat-opt-name">Do not connect</div>
              <div class="plat-opt-sub">Relay will not sync to accounting</div>
            </div>
          </label>
        </div>
      </div>

      <!-- ── Save ── -->
      <button id="pf-save-btn" class="btn btn-primary" data-action="saveProfile">Save changes</button>

      <!-- ── Subscription ── -->
      <p class="sh" style="margin-top:24px">Subscription</p>
      <div class="card card-p">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:14px;font-weight:600">${plan} Plan${plan==='Starter'?' · $49/mo':plan==='Pro'?' · $99/mo':''}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:2px">Managed via Stripe · Renews ${renewStr}</div>
          </div>
          ${subBadge}
        </div>
        <a href="${STRIPE_BILLING}" target="_blank" rel="noopener" class="open-btn" style="background:#f0f4ff;color:#4338ca;border-color:#c7d2fe;margin-top:10px">
          ${I.card} Manage billing on Stripe
        </a>
      </div>

      <!-- ── Legal ── -->
      <div style="text-align:center;margin-top:20px">
        <button class="link-btn" data-nav="privacy" style="font-size:12px;color:#9ca3af">License Agreement & Privacy Policy</button>
      </div>

      <!-- ── Sign out ── -->
      <button class="btn btn-outline" data-action="signOut" style="margin-top:8px;color:#dc2626;border-color:#fca5a5">
        Sign out
      </button>
      <div style="height:32px"></div>
    </div>
  </div>`;
}

function sAdmin() {
  if (S.user?.email !== ADMIN_EMAIL) {
    return `<div class="confirm-wrap" style="padding-top:60px">
      <div style="font-size:40px;margin-bottom:16px">&#x1F512;</div>
      <h2 class="confirm-title">Admin access only</h2>
      <p class="confirm-sub">This area is restricted to Relay, Inc. staff.</p>
      <button class="btn btn-primary" data-nav="dashboard">Go to dashboard</button>
    </div>`;
  }
  return topbar({title:'Relay Dispatch', sub:'Admin · Relay Ai', right:`
    <button class="topbar-btn" data-action="refreshAdmin" title="Refresh">${I.bell}</button>`}) +
  `<div id="admin-content" class="scroll">
    <div class="loading-wrap" style="min-height:200px">
      <div class="spinner"></div>
    </div>
  </div>`;
}

function renderAdminContent() {
  const el = $('admin-content');
  if (!el) return;
  const q = S.queue || [];
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-lbl">Pending dispatch</div><div class="stat-val r">${q.length}</div></div>
      <div class="stat-card"><div class="stat-lbl">Queue status</div><div class="stat-val">${q.length===0?'✓ Clear':'Active'}</div></div>
    </div>
    <p class="sh">Pending dispatch queue</p>
    ${q.length === 0
      ? `<div class="card card-p" style="text-align:center;color:#9ca3af;padding:32px">All caught up — queue is empty ✓</div>`
      : q.map((d, i) => {
          const isQB     = (d.platform||'quickbooks') === 'quickbooks';
          const linkHref = isQB ? qbUrl(d.invoiceDocId||d.docId) : zohoUrl(d.invoiceDocId||d.docId);
          const linkCls  = isQB ? 'qb' : 'zoho';
          const linkTxt  = isQB ? 'Open in QuickBooks' : 'Open in Zoho Books';
          return `<div class="dc">
            <div class="dc-head">
              <div>
                <div class="dc-client">${d.clientName||'Unknown Client'}</div>
                <div class="dc-tags">
                  ${d.type==='invoice'?`<span class="badge sent">Invoice</span>`:`<span class="badge quote">Quote</span>`}
                  ${platBadge(d.platform||'quickbooks')}
                </div>
              </div>
              <div class="dc-amount">${fmt(d.amount||0)}</div>
            </div>
            <div class="dc-body">
              <div class="dc-row"><span class="dc-row-lbl">Customer</span><span class="dc-row-val">${d.customer||'—'} · ${d.phone||'—'}</span></div>
              <div class="dc-row"><span class="dc-row-lbl">Address</span><span class="dc-row-val">${d.address||'—'}</span></div>
              <div class="dc-row"><span class="dc-row-lbl">Work</span><span class="dc-row-val">${d.work||'—'}</span></div>
              <div class="dc-row"><span class="dc-row-lbl">Pricing</span><span class="dc-row-val">${d.pricing||'—'}</span></div>
              <div class="dc-row"><span class="dc-row-lbl">Terms</span><span class="dc-row-val">${d.terms||'Due on receipt'}</span></div>
              <div class="dc-row"><span class="dc-row-lbl">Submitted</span><span class="dc-row-val">${fmtDate(d.submittedAt)}</span></div>
              <a href="${linkHref}" target="_blank" rel="noopener" class="open-btn ${linkCls}">${I.ext} ${linkTxt}</a>
            </div>
            <div class="dc-actions">
              <button class="btn btn-sm btn-success" data-action="approve" data-idx="${i}" data-docid="${d.docId}">${I.check} Approve &amp; send</button>
              <button class="btn btn-sm btn-outline" data-action="hold" data-idx="${i}">${I.msg} Request info</button>
            </div>
          </div>`;
        }).join('')}
    <div style="padding:16px;text-align:center">
      <button class="link-btn" data-nav="dashboard">← Back to portal</button>
    </div>`;
}

// ── ROUTER ────────────────────────────────────────────────────────────────────────────

function sPrivacy() {
  return `
  <div class="topbar">
    <button class="back-btn" data-nav="profile" aria-label="Back" style="color:#1a2f5e">${I.back}</button>
    <span style="font-weight:700;font-size:16px;color:#111827">License Agreement & Privacy Policy</span>
    <span></span>
  </div>
  <div class="scroll" style="padding:20px 20px 48px;max-width:680px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.7;color:#374151">
    <p style="font-size:11px;color:#9ca3af;margin:0 0 24px">Last updated: June 2026</p>

    <h2 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 8px">End-User License Agreement</h2>
    <p style="margin:0 0 16px">This End-User License Agreement ("Agreement") is a legal agreement between you ("User") and Relay Ai USA ("Company," "we," "us," or "our") governing your use of the Relay Ai portal and all related services (collectively, the "Service"). By creating an account or using the Service, you agree to be bound by this Agreement in full.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">1. License Grant</h3>
    <p style="margin:0 0 16px">Subject to your compliance with this Agreement and timely payment of applicable subscription fees, Relay Ai USA grants you a limited, non-exclusive, non-transferable, revocable license to access and use the Service solely for your internal business operations — specifically, automated dispatch management and invoicing for your contracting or service business.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">2. Restrictions</h3>
    <p style="margin:0 0 8px">You agree not to:</p>
    <ul style="margin:0 0 16px;padding-left:20px">
      <li>Resell, sublicense, or redistribute the Service or access to it</li>
      <li>Reverse engineer, decompile, or attempt to extract the source code</li>
      <li>Use the Service for any unlawful purpose or in violation of any applicable regulation</li>
      <li>Interfere with or disrupt the integrity or performance of the Service</li>
      <li>Access the Service using automated means (bots, scrapers) without written consent</li>
      <li>Share login credentials with unauthorized third parties</li>
    </ul>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">3. Subscription & Payment</h3>
    <p style="margin:0 0 16px">Access to the Service requires a paid subscription processed through Stripe. Subscriptions are billed monthly or annually as selected at signup. You authorize Relay Ai USA to charge your payment method on a recurring basis. Failure to maintain a current subscription will result in suspension of access. Refunds are not provided for partial billing periods. We reserve the right to modify pricing with 30 days' notice.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">4. Third-Party Integrations</h3>
    <p style="margin:0 0 16px">The Service integrates with third-party platforms including QuickBooks Online (Intuit Inc.), Zoho Books (Zoho Corporation), Firebase (Google LLC), and Stripe, Inc. By connecting these services, you authorize Relay Ai USA to access and act on data within those platforms on your behalf, limited to the permissions you explicitly grant during the OAuth authorization flow. We do not store your QuickBooks or Zoho Books passwords — only the access tokens provided by those platforms. Your use of third-party services is also governed by those providers' own terms of service.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">5. Disclaimer of Warranties</h3>
    <p style="margin:0 0 16px">THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND. RELAY AI USA EXPRESSLY DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">6. Limitation of Liability</h3>
    <p style="margin:0 0 16px">TO THE FULLEST EXTENT PERMITTED BY LAW, RELAY AI USA SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF OR INABILITY TO USE THE SERVICE. OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ANY CLAIMS ARISING UNDER THIS AGREEMENT SHALL NOT EXCEED THE FEES PAID BY YOU IN THE THREE (3) MONTHS PRECEDING THE CLAIM.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">7. Termination</h3>
    <p style="margin:0 0 16px">We may suspend or terminate your access immediately, without prior notice, if you breach this Agreement, fail to pay subscription fees, or if we discontinue the Service. Upon termination, your right to use the Service ceases immediately. You may export your data prior to termination by contacting support.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">8. Governing Law</h3>
    <p style="margin:0 0 16px">This Agreement shall be governed by and construed in accordance with the laws of the State of Texas, without regard to its conflict of law provisions. Any dispute arising under this Agreement shall be subject to the exclusive jurisdiction of the state and federal courts located in Texas.</p>

    <div style="height:1px;background:#e5e7eb;margin:28px 0"></div>

    <h2 style="font-size:18px;font-weight:700;color:#111827;margin:0 0 8px">Privacy Policy</h2>
    <p style="margin:0 0 16px">Relay Ai USA ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, store, and share your information when you use the Relay Ai portal.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Information We Collect</h3>
    <p style="margin:0 0 8px"><strong>Account Information:</strong> When you register, we collect your email address, company name, and a hashed password managed by Google Firebase Authentication.</p>
    <p style="margin:0 0 8px"><strong>Business Data:</strong> Information you enter into the Service, including customer names, contact details, job descriptions, invoice amounts, payment terms, and labor/material rates.</p>
    <p style="margin:0 0 8px"><strong>Integration Tokens:</strong> When you connect QuickBooks Online or Zoho Books, we receive and store OAuth access tokens and refresh tokens issued by those platforms. We store these securely in Google Firestore and use them only to perform actions you initiate within the Service.</p>
    <p style="margin:0 0 16px"><strong>Payment Information:</strong> Subscription billing is handled entirely by Stripe. We do not store your credit card number, CVV, or full payment details. We receive a Stripe customer ID and subscription status only.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">How We Use Your Information</h3>
    <ul style="margin:0 0 16px;padding-left:20px">
      <li>To provide, operate, and improve the Service</li>
      <li>To create and send invoices and estimates on your behalf to your accounting platform</li>
      <li>To authenticate your identity and maintain your session</li>
      <li>To process subscription payments through Stripe</li>
      <li>To communicate with you about your account, billing, or service updates</li>
      <li>To detect and prevent fraud, abuse, or security incidents</li>
    </ul>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">How We Share Your Information</h3>
    <p style="margin:0 0 8px">We do not sell your personal data. We share data only as necessary to operate the Service:</p>
    <ul style="margin:0 0 16px;padding-left:20px">
      <li><strong>Google Firebase / Firestore:</strong> Hosts our authentication and database</li>
      <li><strong>Stripe:</strong> Processes subscription payments</li>
      <li><strong>Intuit (QuickBooks):</strong> Receives invoice/customer data you authorize us to sync</li>
      <li><strong>Zoho Corporation:</strong> Receives invoice/customer data you authorize us to sync</li>
      <li><strong>Netlify:</strong> Hosts the application and serverless functions</li>
    </ul>
    <p style="margin:0 0 16px">We may disclose information if required by law, court order, or governmental authority, or to protect the rights, property, or safety of Relay Ai USA, our users, or others.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Data Security</h3>
    <p style="margin:0 0 16px">We implement industry-standard security measures including encrypted connections (HTTPS/TLS), Firebase Authentication for identity management, and server-side storage of all OAuth tokens. Third-party credentials (QuickBooks, Zoho) are never stored in your browser or exposed in client-side code. However, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Data Retention</h3>
    <p style="margin:0 0 16px">We retain your account and business data for as long as your account is active or as needed to provide the Service. If you close your account, we will delete your personal data within 90 days, except where retention is required by law. Stripe retains transaction records per their own data retention policies.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Your Rights</h3>
    <p style="margin:0 0 8px">Depending on your location, you may have the right to:</p>
    <ul style="margin:0 0 16px;padding-left:20px">
      <li>Access the personal data we hold about you</li>
      <li>Request correction of inaccurate data</li>
      <li>Request deletion of your data ("right to be forgotten")</li>
      <li>Revoke OAuth access to QuickBooks or Zoho at any time via those platforms' account settings</li>
      <li>Cancel your subscription and export your data before account closure</li>
    </ul>
    <p style="margin:0 0 16px">To exercise these rights, contact us at the email below.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">California Residents (CCPA)</h3>
    <p style="margin:0 0 16px">If you are a California resident, you have the right to know what personal information we collect, the right to delete it, and the right to opt out of the sale of your personal information. We do not sell personal information. To submit a CCPA request, contact us at the email below.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Children's Privacy</h3>
    <p style="margin:0 0 16px">The Service is intended for business use by adults 18 years of age or older. We do not knowingly collect personal information from minors. If we become aware that a minor has provided us with personal information, we will delete it promptly.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Changes to This Policy</h3>
    <p style="margin:0 0 16px">We may update this Privacy Policy and License Agreement from time to time. We will notify you of material changes by posting the updated policy within the Service and updating the "Last updated" date above. Continued use of the Service after changes constitutes acceptance of the updated terms.</p>

    <h3 style="font-size:15px;font-weight:700;color:#111827;margin:20px 0 6px">Contact Us</h3>
    <p style="margin:0 0 32px">For questions about this Agreement or Privacy Policy, data requests, or to report a concern:<br>
    <strong>Relay Ai USA</strong><br>
    Email: <a href="mailto:pryorpropertysolutions269@gmail.com" style="color:#1a2f5e">pryorpropertysolutions269@gmail.com</a><br>
    Website: <a href="https://portal-relay.com" style="color:#1a2f5e">portal-relay.com</a></p>

    <div style="background:#f3f4f6;border-radius:10px;padding:14px 16px;font-size:12px;color:#6b7280;line-height:1.6">
      By using Relay Ai, you acknowledge that you have read, understood, and agree to be bound by this License Agreement and Privacy Policy.
    </div>
  </div>`;
}

const SCREENS = {
  loading: sLoading, login: sLogin, signup: sSignup, plans: sPlans, privacy: sPrivacy,
  locked: sLocked,
  dashboard: sDashboard, submit: sSubmit, confirm: sConfirm,
  invoices: sInvoices, customers: sCustomers, profile: sProfile, admin: sAdmin,
};

function isSubscriptionActive() {
  const status  = S.profile?.subscriptionStatus || 'unpaid';
  const isAdmin = S.user?.email === ADMIN_EMAIL;
  return isAdmin || status === 'active' || status === 'trialing';
}

function go(screen) {
  if (!SCREENS[screen]) return;
  // Only hard-lock canceled or suspended accounts; unpaid users see dashboard with payment banner
  if (PROTECTED.has(screen) && S.user && S.user.email !== ADMIN_EMAIL) {
    const status = S.profile?.subscriptionStatus || 'unpaid';
    if (status === 'canceled' || status === 'suspended') {
      screen = 'locked';
    }
  }
  S.screen = screen;
  render();
  if (screen === 'admin' && S.user?.email === ADMIN_EMAIL) {
    loadDispatchQueue().then(renderAdminContent);
  }
}

function render() {
  const appEl = $('app');
  appEl.innerHTML = SCREENS[S.screen]();
  if (S.screen === 'customers') {
    const si = $('cx-search');
    if (si) {
      si.addEventListener('input', e => {
        S.search = e.target.value;
        const q  = S.search.toLowerCase();
        const cx = S.customers || [];
        const list = q ? cx.filter(c => (c.name||'').toLowerCase().includes(q) || (c.phone||'').includes(q)) : cx;
        const el = $('cx-list');
        if (el) el.innerHTML = cxRows(list);
      });
    }
  }
}

// ── AUTH ACTIONS ───────────────────────────────────────────────────────────────────────────

async function doLogin() {
  const email = $('lg-email')?.value.trim();
  const pw    = $('lg-pw')?.value;
  if (!email || !pw) { showErr('lg-err', 'Please enter your email and password.'); return; }
  setBtn('lg-btn', true, 'Sign in to Relay');
  showErr('lg-err', '');
  try {
    await auth.signInWithEmailAndPassword(email, pw);
  } catch(e) {
    setBtn('lg-btn', false, 'Sign in to Relay');
    showErr('lg-err', friendlyAuthError(e.code));
  }
}

async function doGoogleLogin() {
  showErr('lg-err', '');
  showErr('sg-err', '');
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  } catch(e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      showErr('lg-err', friendlyAuthError(e.code));
      showErr('sg-err', friendlyAuthError(e.code));
    }
  }
}

async function doSignup() {
  const company  = $('sg-co')?.value.trim();
  const email    = $('sg-email')?.value.trim();
  const pw       = $('sg-pw')?.value;
  const pw2      = $('sg-pw2')?.value;
  const platform = $('sg-platform')?.value || 'quickbooks';

  if (!company)    { showErr('sg-err', 'Please enter your company name.'); return; }
  if (!email)      { showErr('sg-err', 'Please enter your email address.'); return; }
  if (!pw)         { showErr('sg-err', 'Please create a password.'); return; }
  if (pw !== pw2)  { showErr('sg-err', 'Passwords do not match.'); return; }
  if (pw.length < 6) { showErr('sg-err', 'Password must be at least 6 characters.'); return; }

  setBtn('sg-btn', true, 'Create my Relay account');
  showErr('sg-err', '');

  S._pendingProfile = {
    companyName:        company,
    email:              email,
    plan:               'Starter',
    platform:           platform,
    laborRate:          100,
    materialMarkup:     15,
    paymentTerms:       'Due on receipt',
    subscriptionStatus: 'unpaid',
    createdAt:          firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pw);
    await cred.user.updateProfile({ displayName: company });
  } catch(e) {
    delete S._pendingProfile;
    setBtn('sg-btn', false, 'Create my Relay account');
    showErr('sg-err', friendlyAuthError(e.code));
  }
}

async function doSignOut() {
  try { await auth.signOut(); } catch(e) { console.error(e); }
}

async function doSaveProfile() {
  if (!S.user) return;
  const name     = $('pf-name')?.value.trim()   || S.profile?.companyName;
  const terms    = $('pf-terms')?.value          || S.profile?.paymentTerms;
  const labor    = parseFloat(($('pf-labor')?.value   ||'').replace(/[^0-9.]/g,'')) || 100;
  const markup   = parseFloat(($('pf-markup')?.value  ||'').replace(/[^0-9.]/g,'')) || 15;
  const platform = document.querySelector('input[name="pf-plat"]:checked')?.value || S.profile?.platform || 'quickbooks';
  const btn      = $('pf-save-btn');

  // Normalize phone: strip spaces/dashes, ensure + prefix
  let phone = ($('pf-phone')?.value || '').replace(/[\s\-\(\)]/g,'').trim();
  if (phone && !phone.startsWith('+')) phone = '+1' + phone.replace(/^\+?1?/,'');
  const prevPhone = S.profile?.businessPhone || null;

  try {
    const updates = { companyName: name, paymentTerms: terms, laborRate: labor, materialMarkup: markup, platform };
    if (phone) updates.businessPhone = phone;

    await db.collection('users').doc(S.user.uid).update(updates);

    // ── Phone registry: maps phone number → uid so SMS inbound can look up the account
    if (phone && phone !== prevPhone) {
      const batch = db.batch();
      // Remove old mapping if phone changed
      if (prevPhone) batch.delete(db.collection('phone_registry').doc(prevPhone));
      // Write new mapping
      batch.set(db.collection('phone_registry').doc(phone), {
        uid:         S.user.uid,
        companyName: name,
        updatedAt:   firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
    }

    S.profile = {...S.profile, companyName:name, paymentTerms:terms, laborRate:labor, materialMarkup:markup, platform, ...(phone && {businessPhone:phone})};

    // If Zoho was selected but not yet connected, kick off OAuth immediately after saving
    if (platform === 'zoho' && !S.profile?.zoho?.connected) {
      if (btn) { btn.textContent = 'Connecting to Zoho…'; btn.disabled = true; }
      setTimeout(() => startZohoConnect(), 500);
      return;
    }
    // If QuickBooks was selected but not yet connected, kick off OAuth
    if (platform === 'quickbooks' && !S.profile?.quickbooks?.connected) {
      if (btn) { btn.textContent = 'Connecting to QuickBooks…'; btn.disabled = true; }
      setTimeout(() => startQuickBooksConnect(), 500);
      return;
    }

    if (btn) { btn.textContent = 'Saved ✓'; btn.disabled = true; setTimeout(()=>{ btn.textContent='Save changes'; btn.disabled=false; }, 2000); }
  } catch(e) {
    console.error('saveProfile:', e);
    alert('Could not save. Please try again.');
  }
}

// ── JOB ACTIONS ────────────────────────────────────────────────────────────────────────────

async function handleSubmitJob() {
  const name  = $('f-name')?.value.trim();
  const phone = $('f-phone')?.value.trim();
  const email = $('f-email')?.value.trim() || '';
  const addr  = $('f-addr')?.value.trim();
  const work  = $('f-work')?.value.trim();
  const total = $('f-total')?.value.trim();
  const mat   = $('f-mat')?.value.trim();
  const lab   = $('f-lab')?.value.trim();

  if (!isSubscriptionActive()) {
    showErr('sub-err', 'Your account must be active to submit jobs. Complete payment above to unlock the Relay dispatch line.');
    return;
  }
  if (!name)  { showErr('sub-err', 'Customer name is required.'); return; }
  if (!phone) { showErr('sub-err', 'Customer phone is required.'); return; }
  if (!addr)  { showErr('sub-err', 'Job address is required.'); return; }
  if (!work)  { showErr('sub-err', 'Work description is required.'); return; }

  const amountStr = total || [mat, lab].filter(Boolean).join(' + ') || '0';
  const amount    = parseFloat(amountStr.replace(/[^0-9.]/g, '')) || 0;
  if (!amount)    { showErr('sub-err', 'Please enter the job amount.'); return; }

  setBtn('sub-btn', true, 'Send to Relay dispatch');
  showErr('sub-err', '');

  const uid      = S.user.uid;
  const platform = S.profile?.platform      || 'quickbooks';
  const terms    = S.profile?.paymentTerms  || 'Due on receipt';
  const pricing  = S.formPrice === 'flat'
    ? `Flat rate: ${amountStr}`
    : `Materials: ${mat||'$0'} + Labor: ${lab||'$0'}`;
  const dateStr  = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'});

  const jobData = {
    customer: name, phone, email, address: addr, work,
    amount, type: S.formType, status: 'pending',
    platform, pricing, terms, date: dateStr,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const invRef = await db.collection('users').doc(uid).collection('invoices').add(jobData);
    await db.collection('dispatch').add({
      ...jobData,
      clientUid:    uid,
      clientName:   S.profile?.companyName || 'Unknown',
      invoiceDocId: invRef.id,
      status:       'pending',
      submittedAt:  firebase.firestore.FieldValue.serverTimestamp(),
    });

    const cxQ = await db.collection('users').doc(uid).collection('customers').where('phone','==',phone).get();
    if (cxQ.empty) {
      await db.collection('users').doc(uid).collection('customers').add({
        name, phone, email, jobs: 1, total: amount, owed: amount,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await cxQ.docs[0].ref.update({
        jobs:  firebase.firestore.FieldValue.increment(1),
        total: firebase.firestore.FieldValue.increment(amount),
        owed:  firebase.firestore.FieldValue.increment(amount),
      });
    }

    await loadUserData(uid);
    S.lastJob = {type: S.formType, customer: name, amount: fmt(amount)};
    go('confirm');
  } catch(e) {
    console.error('submitJob:', e);
    setBtn('sub-btn', false, 'Send to Relay dispatch');
    showErr('sub-err', 'Could not submit. Check your connection and try again.');
  }
}

async function handleApprove(docId, idx) {
  const job = S.queue[parseInt(idx)];
  if (!job || !docId) return;
  try {
    await db.collection('dispatch').doc(docId).update({
      status:     'approved',
      approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (job.clientUid && job.invoiceDocId) {
      await db.collection('users').doc(job.clientUid).collection('invoices').doc(job.invoiceDocId).update({status:'sent'});
    }
    S.queue.splice(parseInt(idx), 1);
    renderAdminContent();
  } catch(e) {
    console.error('approve:', e);
    alert('Could not approve. Please try again.');
  }
}

// ── EVENTS ──────────────────────────────────────────────────────────────────────────────

function handleClick(e) {
  // Platform radio visual selection
  const platOpt = e.target.closest('.plat-opt');
  if (platOpt) {
    // If user clicked the Connect button inside the card, let its onclick fire — don't intercept
    if (e.target.closest('button[onclick]')) return;
    document.querySelectorAll('.plat-opt').forEach(el => el.classList.remove('plat-sel'));
    platOpt.classList.add('plat-sel');
    const radio = platOpt.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    return;
  }

  const navEl = e.target.closest('[data-nav]');
  if (navEl) { go(navEl.dataset.nav); return; }

  const togEl = e.target.closest('[data-toggle]');
  if (togEl) {
    if (togEl.dataset.toggle === 'type')  S.formType  = togEl.dataset.val;
    if (togEl.dataset.toggle === 'price') S.formPrice = togEl.dataset.val;
    render(); return;
  }

  const filtEl = e.target.closest('[data-filter]');
  if (filtEl) { S.filter = filtEl.dataset.filter; render(); return; }

  const actEl = e.target.closest('[data-action]');
  if (actEl) handleAction(actEl.dataset.action, actEl.dataset.idx, actEl.dataset.docid);
}

function handleAction(action, idx, docId) {
  switch(action) {
    case 'login':        doLogin();                  break;
    case 'googleLogin':  doGoogleLogin();            break;
    case 'signup':       doSignup();                 break;
    case 'signOut':      doSignOut();                break;
    case 'saveProfile':  doSaveProfile();            break;
    case 'submitJob':    handleSubmitJob();          break;
    case 'approve':      handleApprove(docId, idx); break;
    case 'goAdmin':      go('admin');               break;
    case 'refreshAdmin': loadDispatchQueue().then(renderAdminContent); break;
    case 'hold': {
      const d = S.queue[parseInt(idx)];
      if (d) alert(`Info request sent to ${d.clientName||'client'} for ${d.customer||'customer'}.`);
      break;
    }
  }
}

// ── INIT ─────────────────────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  const bg = type === 'success' ? '#16a34a' : '#dc2626';
  t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:12px 20px;border-radius:12px;
    font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);
    animation:fadeIn .25s ease;max-width:80vw;text-align:center`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function showFatalError(msg) {
  document.getElementById('app').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100vh;padding:32px;text-align:center;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
      <div style="width:54px;height:54px;background:#1a2f5e;border-radius:14px;
                  display:flex;align-items:center;justify-content:center;margin-bottom:20px;">
        <span style="color:#fff;font-size:22px;font-weight:800">R</span>
      </div>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:8px">Something went wrong</div>
      <div style="font-size:14px;color:#6b7280;line-height:1.6;margin-bottom:24px;max-width:280px">${msg}</div>
      <button onclick="location.reload()"
              style="padding:12px 24px;background:#1a2f5e;color:#fff;border:none;
                     border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">
        Retry →
      </button>
    </div>`;
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW:', e));
  }
  auth.onAuthStateChanged(async user => {
    if (!user) { go('login'); return; }
    S.user = user;
    try {
      const snap = await db.collection('users').doc(user.uid).get();
      const data = snap.data() || {};
      S.profile = data;
      const status = data.subscriptionStatus || 'unpaid';
      S.subscriptionStatus = status;
      const isAdmin = user.email === ADMIN_EMAIL;
      S.isAdmin = isAdmin;
      if (isAdmin) { go('dashboard'); return; }
      if (['active', 'trialing'].includes(status)) { go('dashboard'); }
  
'use strict';

// ââ FIREBASE SDK GUARD ââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
        Retry â
      </button>
    </div>`;
  throw new Error('Firebase SDK not loaded â CDN may be blocked or offline.');
}

// ââ FIREBASE ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ STRIPE PAYMENT LINKS ââââââââââââââââââââââââââââââââââââââââââââââââââ
// Replace these with your real links from stripe.com/payment-links
const STRIPE_STARTER        = 'https://buy.stripe.com/7sYaEZ51C4i8aW58HC6g801';
const STRIPE_ESSENTIAL      = 'https://buy.stripe.com/00w4gB79K9CsaW59LG6g802';
const STRIPE_ESSENTIAL_PLUS = 'https://buy.stripe.com/6oU6oJdy82a0aW59LG6g800';
const STRIPE_BILLING        = 'https://billing.stripe.com/p/login/6oU6oJdy82a0aW59LG6g800';

// ── ACCOUNTING INTEGRATION OAUTH ─────────────────────────────────────────────
// Register at developer.intuit.com (QuickBooks) and
// accounts.zoho.com/developerconsole (Zoho Books).
// Set redirect URI to: https://portal-relay.com/oauth-callback.html
const INTUIT_CLIENT_ID = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
const ZOHO_CLIENT_ID   = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
const OAUTH_REDIRECT   = 'https://portal-relay.com/oauth-callback.html';

// Plan tier constants
const PLAN_STARTER       = 'starter';
const PLAN_ESSENTIAL     = 'essential';
const PLAN_ESSENTIAL_PLUS = 'essential_plus';

// Feature gate helpers — checked server-side in twilio-sms.js AND client-side in portal
function isAdminUser() { return S.user?.email === ADMIN_EMAIL; }
function canSMSDispatch(plan) {
  return isAdminUser() || ['essential','essential+','essential_plus'].includes((plan||'').toLowerCase());
}
function canAutoForward(plan) { return isAdminUser() || ['essential+','essential_plus'].includes((plan||'').toLowerCase()); }
function canReviewRequest(plan) { return isAdminUser() || ['essential+','essential_plus'].includes((plan||'').toLowerCase()); }
function docLimit(plan) { return (isAdminUser() || ['essential+','essential_plus'].includes((plan||'').toLowerCase())) ? 500 : 250; }
function getMonthKey() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
async function checkAndIncrementDocCount(uid, plan) {
  if (isAdminUser()) return; // admin unlimited
  const key   = getMonthKey();
  const ref   = db.collection('users').doc(uid).collection('docCounts').doc(key);
  const snap  = await ref.get();
  const count = snap.exists ? (snap.data().count || 0) : 0;
  const limit = docLimit(plan);
  if (count >= limit) throw Object.assign(new Error('DOC_LIMIT_REACHED'), {limit, count});
  await ref.set({ count: firebase.firestore.FieldValue.increment(1), updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
// Protected screens â require active subscription
const PROTECTED = new Set(['dashboard','submit','invoices','customers','profile']);

// ââ STATE âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ SVG ICONS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ HELPERS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
    'auth/network-request-failed': 'Network error â check your connection.',
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
  el.textContent = loading ? 'Please waitâ¦' : label;
}

// ââ FIREBASE DATA âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function loadUserData(uid) {
  try {
    const monthKey = getMonthKey();
    const [profSnap, invSnap, cxSnap, dcSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(uid).collection('invoices').get(),
      db.collection('users').doc(uid).collection('customers').get(),
      db.collection('users').doc(uid).collection('docCounts').doc(monthKey).get(),
    ]);

    S.profile = profSnap.exists ? profSnap.data() : {
      companyName: S.user.displayName || 'My Company',
      plan: 'Starter',
      platform: 'quickbooks',
      laborRate: 100,
      materialMarkup: 15,
      paymentTerms: 'Due on receipt',
    };

    // Admin always gets Essential+ regardless of Firestore plan field
    if (S.user?.email === ADMIN_EMAIL) {
      S.profile = {
        ...S.profile,
        plan: 'Essential+',
        subscriptionStatus: 'active',
        autoForwardToCustomer: S.profile?.autoForwardToCustomer ?? false,
        reviewUrl: S.profile?.reviewUrl || '',
      };
    }

    S.invoices = invSnap.docs
      .map(d => ({docId: d.id, ...d.data()}))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

    S.customers = cxSnap.docs.map(d => ({docId: d.id, ...d.data()}));
    S.docCountThisMonth = dcSnap.exists ? (dcSnap.data().count || 0) : 0;
  } catch(e) {
    console.error('loadUserData:', e);
    if (!S.profile) S.profile = {companyName: 'My Company', plan: 'Essential+', platform: 'quickbooks'};
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

// ââ COMPONENTS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ SCREENS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
      <input id="lg-pw" type="password" class="input" placeholder="â¢â¢â¢â¢â¢â¢â¢â¢" autocomplete="current-password">
    </div>
    <button id="lg-btn" class="btn btn-primary" data-action="login" style="margin-bottom:8px">Sign in to Relay</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Continue with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="signup">New to Relay? Create an account â</button>
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
    <label style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;cursor:pointer;">
      <input id="sg-sms" type="checkbox" style="margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:#6366f1;">
      <span style="font-size:12px;color:#6b7280;line-height:1.5;">I agree to receive SMS text messages from RelayAI with setup info and dispatch instructions. Msg &amp; data rates may apply. Reply STOP to opt out anytime.</span>
    </label>
    <button id="sg-btn" class="btn btn-primary" data-action="signup" style="margin-bottom:8px">Create my Relay account</button>
    <div class="divider"><span class="divider-line"></span><span class="divider-text">or</span><span class="divider-line"></span></div>
    <button class="btn btn-outline" data-action="googleLogin" style="gap:10px">
      ${I.google} Sign up with Google
    </button>
    <div style="margin-top:auto;padding-top:28px;text-align:center">
      <button class="link-btn" data-nav="login">Already have an account? Sign in â</button>
    </div>
  </main>`;
}

function sLocked(featureName) {
  return topbar({title:'Upgrade Required'}) +
    `<div class="scroll" style="padding:24px 16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;margin-bottom:12px">🔒</div>
        <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">Unlock ${featureName}</h2>
        <p style="font-size:14px;color:#6b7280">This feature requires an upgraded plan. Choose a plan below to get started.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="plan-card">
          <div class="plan-name">Starter</div>
          <div class="plan-price">$19<span>/mo</span></div>
          <div class="plan-feat">
            <div class="plan-feat-item">${I.check}Portal access &amp; manual doc creation</div>
            <div class="plan-feat-item">${I.check}Up to 250 documents/month</div>
            <div class="plan-feat-item">${I.check}QuickBooks &amp; Zoho Books sync</div>
          </div>
          <a href="${STRIPE_STARTER}" target="_blank" rel="noopener"
             class="btn btn-outline" style="margin-top:12px;display:block;text-align:center">
            Get Starter
          </a>
        </div>
        <div class="plan-card featured">
          <div style="margin-bottom:8px"><span class="badge paid">Most popular</span></div>
          <div class="plan-name">Essential</div>
          <div class="plan-price">$59<span>/mo</span></div>
          <div class="plan-feat">
            <div class="plan-feat-item">${I.check}Everything in Starter</div>
            <div class="plan-feat-item">${I.check}AI SMS Dispatch</div>
            <div class="plan-feat-item">${I.check}Up to 250 documents/month</div>
          </div>
          <a href="${STRIPE_ESSENTIAL}" target="_blank" rel="noopener"
             class="btn btn-primary" style="margin-top:12px;display:block;text-align:center">
            Get Essential
          </a>
        </div>
        <div class="plan-card">
          <div class="plan-name">Essential+</div>
          <div class="plan-price">$99<span>/mo</span></div>
          <div class="plan-feat">
            <div class="plan-feat-item">${I.check}Everything in Essential</div>
            <div class="plan-feat-item">${I.check}500 documents/month</div>
            <div class="plan-feat-item">${I.check}Auto-forward docs to customers</div>
            <div class="plan-feat-item">${I.check}Automated review request SMS</div>
          </div>
          <a href="${STRIPE_ESSENTIAL_PLUS}" target="_blank" rel="noopener"
             class="btn btn-outline" style="margin-top:12px;display:block;text-align:center">
            Get Essential+
          </a>
        </div>
      </div>
      <div style="height:16px"></div>
    </div>`;
}
function sPlans() {
  return topbar({title:'Choose Your Plan', back:'signup'}) +
    `<div class="scroll">
      <p style="font-size:13px;color:#6b7280;margin-bottom:14px">Billed directly via Stripe — no app store cut. Cancel anytime.</p>
      <div class="plan-card">
        <div class="plan-name">Starter</div>
        <div class="plan-price">$19<span>/mo</span></div>
        <div class="plan-feat">
          <div class="plan-feat-item">${I.check}Job submissions &amp; customer portal</div>
          <div class="plan-feat-item">${I.check}Invoice creation and tracking</div>
          <div class="plan-feat-item">${I.check}Customer registry</div>
          <div class="plan-feat-item">${I.check}Basic dispatch management</div>
        </div>
        <a href="${STRIPE_STARTER}" target="_blank" rel="noopener" class="btn btn-outline" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Get started</a>
      </div>
      <div class="plan-card featured">
        <div style="margin-bottom:8px"><span class="badge paid">Most popular</span></div>
        <div class="plan-name">Essential+</div>
        <div class="plan-price">$49<span>/mo</span></div>
        <div class="plan-feat">
          <div class="plan-feat-item">${I.check}Everything in Starter</div>
          <div class="plan-feat-item">${I.check}AI writes your invoices, estimates &amp; documents</div>
          <div class="plan-feat-item">${I.check}Connect QuickBooks or Zoho — no double entry ever</div>
          <div class="plan-feat-item">${I.check}14-day free trial included</div>
        </div>
        <a href="${STRIPE_ESSENTIAL}" target="_blank" rel="noopener" class="btn btn-primary" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Start free trial</a>
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
        <a href="${STRIPE_PRO}" target="_blank" rel="noopener" class="btn btn-outline" style="margin-top:12px;display:block;text-align:center;text-decoration:none">Start free trial</a>
      </div>
      <div style="height:16px"></div>
    </div>`;
}
function sDashboard() {
  const name    = S.profile?.companyName || 'My Company';
  const plan    = S.profile?.plan        || 'Starter';
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

  return topbar({title: name, sub: `${plan} Plan · Active`, right:`
    ${isAdmin ? `<button class="topbar-btn" data-action="goAdmin" title="Admin">${I.shield}</button>` : ''}
    <button class="topbar-btn" data-nav="profile" title="Settings">${I.settings}</button>
    <button class="topbar-btn" title="Notifications">${I.bell}</button>`}) +
  `<div class="scroll">${trialBanner}${pastDueBanner}

    <div style="margin-bottom:4px">
      <svg viewBox="0 0 390 298" xmlns="http://www.w3.org/2000/svg" style="width:100%;border-radius:18px;display:block">
        <defs>
          <linearGradient id="dbg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#0f1f45"/><stop offset="100%" style="stop-color:#1d4ed8"/></linearGradient>
          <linearGradient id="s1g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#34d399"/><stop offset="100%" style="stop-color:#10b981"/></linearGradient>
          <linearGradient id="s2g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#60a5fa"/><stop offset="100%" style="stop-color:#3b82f6"/></linearGradient>
          <linearGradient id="s3g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#c084fc"/><stop offset="100%" style="stop-color:#9333ea"/></linearGradient>
          <linearGradient id="wg" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:rgba(255,255,255,0.07)"/><stop offset="100%" style="stop-color:rgba(255,255,255,0.03)"/></linearGradient>
          <filter id="dgl"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <rect width="390" height="298" rx="20" fill="url(#dbg)"/>
        <circle cx="330" cy="25" r="70" fill="rgba(255,255,255,0.03)"/>
        <circle cx="370" cy="80" r="45" fill="rgba(255,255,255,0.025)"/>
        <text x="374" y="19" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="10.5" font-weight="700" fill="rgba(255,255,255,0.28)" text-anchor="end">RelayAi</text>
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
        <rect x="351" y="148" width="14" height="14" rx="2" fill="none" stroke="rgba(96,165,250,0.48)" stroke-width="1.3"/>
        <line x1="354" y1="153" x2="362" y2="153" stroke="rgba(96,165,250,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="354" y1="156" x2="362" y2="156" stroke="rgba(96,165,250,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="354" y1="159" x2="359" y2="159" stroke="rgba(96,165,250,0.48)" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="36" y1="171" x2="36" y2="191" stroke="rgba(96,165,250,0.38)" stroke-width="1.5" stroke-dasharray="3,3"/>
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
    <div class="form-group"><label class="form-lbl" for="f-work">Work description <span class="req">Describe what was done in two to four sentences. Provide any critical detail needed.</span></label><textarea id="f-work" class="input" placeholder="Describe what was done in 2â3 sentences.&#10;e.g. Removed and replaced water heater, installed new supply valve."></textarea></div>
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
    <div class="form-group"><label class="form-lbl" for="f-notes">Special Notes</label><input id="f-notes" type="text" class="input" placeholder="e.g. Address invoice to property manager"></div>
    <!-- Document Template File -->
    <div class="form-group">
      <label class="form-lbl">Document Template File</label>
      <span class="form-hint">Upload a blank template or example document. Relay AI will use this as the format when generating documents for each customer.</span>
      <div class="template-upload-wrap">
        <input type="file" id="f-template" accept=".pdf,.doc,.docx" class="form-input" onchange="handleTemplateUpload(this)">
        <p class="template-hint" id="f-template-status"></p>
      </div>
    </div>
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
    <h2 class="confirm-title">Job Submitted!</h2>
    <p class="confirm-sub">Relay is processing your ${j.type}. Your customer will receive it by email and text shortly.</p>
    <div class="confirm-card">
      <div style="font-size:11px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px">${j.type} Â· ${j.customer}</div>
      <div style="font-size:28px;font-weight:700;color:#111827">${j.amount}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:8px;line-height:1.7">
        Sent to Relay dispatch â<br>
        Auto-reminder after 72 hrs if unpaid â<br>
        Google review request sent after payment â
      </div>
    </div>
    ${j.docId ? `<button class="btn btn-outline" onclick="(function(){navigator.clipboard.writeText('https://portal-relay.com/doc/'+j.docId);this.textContent='✓ Link copied!';setTimeout(()=>this.textContent='📋 Copy customer link',2000)}).call(this)" style="margin-bottom:10px">📋 Copy customer link</button>` : ''}
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
                <div class="inv-meta">${work}${(inv.work||'').length > 34 ? 'â¦' : ''} Â· ${fmtDate(inv.createdAt)}</div>
              </div>
              <div class="inv-right">
                <div class="inv-amt">${fmt(inv.amount || 0)}</div>
                <div style="margin-top:4px">${badge(inv.status || 'pending')}</div>
                ${inv.docId ? `<button onclick="(function(){navigator.clipboard.writeText('https://portal-relay.com/doc/${inv.docId}');this.textContent='✓ Copied';setTimeout(()=>this.textContent='Share',1800)}).call(this)" style="margin-top:5px;font-size:11px;padding:3px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;color:#374151">Share</button>` : ''}
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">
            ${S.filter==='all' ? 'No invoices yet â submit your first job!' :             `No ${S.filter} invoices found.`}
          </div>`
      }
    </div>
  </div>
  ${tabs('invoices')}`;
}

function sCustomers() {
  const cxs = S.customers || [];
  return topbar({title:'Customers', sub:`${cxs.length} total`, right:`<button class="topbar-btn">${I.bell}</button>`}) +
  `<div class="scroll" style="padding:12px 16px">
    <div class="card">
      ${cxs.length
        ? cxs.map(cx => {
            const ini = getInitials(cx.name || '?');
            const col = avatarColor(cx.name || '');
            return `<div class="inv-item">
              <div class="inv-av" style="background:${col.bg};color:${col.fg}">${ini}</div>
              <div class="inv-info">
                <div class="inv-name">${cx.name || 'Unknown'}</div>
                <div class="inv-meta">${cx.phone || ''}${cx.email ? ' Â· ' + cx.email : ''}</div>
              </div>
            </div>`;
          }).join('')
        : `<div style="padding:32px;text-align:center;color:#9ca3af;font-size:14px">
            No customers yet â submit your first job to add one!
          </div>`
      }
    </div>
  </div>
  ${tabs('customers')}`;
}
function sProfile() {
  const p    = S.profile || {};
  const plan = (p.plan || 'starter').toLowerCase();
  const sub  = p.subscriptionStatus || 'unpaid';
  const isEssentialPlus = canAutoForward(plan);
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
      ? `<span class="badge paid">${p.plan || 'Starter'} Plan · Active</span>`
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
  const _zhUrl = `https://accounts.zoho.com/oauth/v2/auth?client_id=${ZOHO_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&scope=ZohoBooks.fullaccess.all&response_type=code&access_type=offline&state=zoho_${_uid}`;
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
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:12px;font-weight:600;color:#374151">Documents this month</span>
          <span style="font-size:12px;color:#6b7280">${S.docCountThisMonth||0} / ${docLimit(plan)}</span>
        </div>
        <div style="height:6px;background:#e5e7eb;border-radius:99px;overflow:hidden">
          <div style="height:100%;width:${Math.min(100,Math.round(((S.docCountThisMonth||0)/docLimit(plan))*100))}%;background:${((S.docCountThisMonth||0)/docLimit(plan))>0.85?'#ef4444':'#1d4ed8'};border-radius:99px;transition:width .3s"></div>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-top:5px">${docLimit(plan)-(S.docCountThisMonth||0)} remaining · resets ${new Date(new Date().getFullYear(),new Date().getMonth()+1,1).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
      </div>

      <!-- ── Business Info ── -->
      <p class="sh">Business Info</p>
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

      ${isEssentialPlus ? `
      <p class="sh">Essential+ <span class="badge paid" style="font-size:11px;margin-left:4px">Essential+</span></p>
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
        <div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:4px">Essential+ features locked</div>
        <div style="font-size:12px;color:#92400e">Upgrade to unlock auto-forward and review SMS.</div>
        <a href="${STRIPE_ESSENTIAL_PLUS}" target="_blank" rel="noopener" style="font-size:12px;color:#1a2f5e;font-weight:600;text-decoration:underline">Upgrade now →</a>
      </div>` : '')}

      <!-- ── Connect Invoicing Software ── -->
      <p class="sh" style="margin-top:4px">Connect your invoicing software</p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:16px">
        <p style="font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.5">Connect QuickBooks or Zoho Books and Relay will automatically log every invoice into your accounting software on your behalf — no double entry.</p>
        ${acctSoftwareHtml}
      </div>

      <button id="pf-save" class="btn btn-primary" data-action="saveProfile" style="margin-bottom:12px">Save changes</button>
      ${billingRow}
      <button class="btn btn-outline" data-action="signOut" style="margin-bottom:28px">${I.logout} Sign out</button>
    </div>
    ${tabs('profile')}`;
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
  profile:   sProfile,
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

// ââ EVENT DELEGATION ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

document.addEventListener('click', async e => {
  const navEl    = e.target.closest('[data-nav]');
  const actionEl = e.target.closest('[data-action]');
  const toggleEl = e.target.closest('[data-toggle]');
  const filterEl = e.target.closest('[data-filter]');

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

  // ââ LOGIN ââ
  if (action === 'login') {
    const email = $('lg-email')?.value?.trim();
    const pw    = $('lg-pw')?.value;
    if (!email || !pw) { showErr('lg-err', 'Please enter your email and password.'); return; }
    setBtn('lg-btn', true, 'Sign in to Relay');
    try {
      await auth.signInWithEmailAndPassword(email, pw);
    } catch(err) {
      showErr('lg-err', friendlyAuthError(err.code));
      setBtn('lg-btn', false, 'Sign in to Relay');
    }
    return;
  }

  // ââ GOOGLE LOGIN ââ
  if (action === 'googleLogin') {
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch(err) {
      showErr(S.screen === 'signup' ? 'sg-err' : 'lg-err', friendlyAuthError(err.code));
    }
    return;
  }

  // ââ SIGN UP ââ
  if (action === 'signup') {
    const co    = $('sg-co')?.value?.trim();
    const email = $('sg-email')?.value?.trim();
    const pw    = $('sg-pw')?.value;
    const pw2   = $('sg-pw2')?.value;
    const plat  = $('sg-platform')?.value || 'quickbooks';
    if (!co)          { showErr('sg-err', 'Please enter your company name.'); return; }
    if (!email)       { showErr('sg-err', 'Please enter your email.'); return; }
    if (pw !== pw2)   { showErr('sg-err', 'Passwords do not match.'); return; }
    setBtn('sg-btn', true, 'Create my Relay account');
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      const phone      = ($('sg-phone')?.value || '').trim();
      const smsConsent = !!$('sg-sms')?.checked;
      await db.collection('users').doc(cred.user.uid).set({
        companyName:        co,
        platform:           plat,
        plan:               'Essential+',
        subscriptionStatus: 'unpaid',
        phone:              phone,
        smsConsent:         smsConsent,
        createdAt:          firebase.firestore.FieldValue.serverTimestamp(),
      });
      // Send welcome SMS if user opted in
      if (smsConsent && phone) {
        fetch('/.netlify/functions/send-welcome-sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, name: co, companyName: co }),
        }).catch(e => console.warn('Welcome SMS failed:', e));
      }
    } catch(err) {
      showErr('sg-err', friendlyAuthError(err.code));
      setBtn('sg-btn', false, 'Create my Relay account');
    }
    return;
  }

  // ââ SIGN OUT ââ
  if (action === 'signOut') {
    await auth.signOut();
    S.user = null; S.profile = null; S.invoices = []; S.customers = [];
    nav('login');
    return;
  }

  // ââ SUBMIT JOB ââ
  if (action === 'submitJob') {
    const name  = $('f-name')?.value?.trim();
    const phone = $('f-phone')?.value?.trim();
    const addr  = $('f-addr')?.value?.trim();
    const work  = $('f-work')?.value?.trim();
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
    }    setBtn('sub-btn', true, 'Send to Relay dispatch');
    try {
      const uid  = S.user.uid;
      const plan = (S.profile?.plan || 'starter').toLowerCase();
      try {
        await checkAndIncrementDocCount(uid, plan);
      } catch(limitErr) {
        if (limitErr.message === 'DOC_LIMIT_REACHED') {
          showErr('sub-err', `Monthly document limit reached (${limitErr.limit} docs/mo on your plan). Please upgrade to continue.`);
          setBtn('sub-btn', false, 'Send to Relay dispatch');
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
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        platform:  S.profile?.platform || 'quickbooks',
        sentAt:              new Date(),
        reviewRequestSent:   false,
      });
      await db.collection('dispatch').add({
        userId:      uid,
        invoiceId:   invRef.id,
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
      showErr('sub-err', 'Submission failed â please try again.');
      setBtn('sub-btn', false, 'Send to Relay dispatch');
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
      const updates = {
        companyName: co, platform: plat, businessType: bizType, businessTypeOther: bizTypeOther,
        licenseNumber: license, minCallFee: callFee, taxRate: taxRate,
        paymentTerms: terms, estimateValidity: validity, invoicePrefix: invPrefix,
        invoiceFooter: footer, paymentMethods: payMethods, paymentMethodOther: payMethodOther,
        paymentUsernames,
      };
      const plan = (S.profile?.plan || '').toLowerCase();
      if (canAutoForward(plan)) {
        updates.reviewUrl = reviewUrl;
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

// ââ BOOT âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Check for Stripe payment redirect signal
if (location.search.includes('payment=success') || location.hash.includes('payment=success')) {
  S._paymentReceived = true;
}

// Show loading immediately
$('app').innerHTML = sLoading();

// Firebase auth state â single source of truth for routing
auth.onAuthStateChanged(async user => {
  if (!user) {
    S.user    = null;
    S.profile = null;
    nav('login');
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
    // unpaid, canceled, suspended â locked screen
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

  status.textContent = "Uploading…";
  status.style.color = "#718096";

  try {
    const uid  = firebase.auth().currentUser?.uid;
    if (!uid) throw new Error("Not signed in");
    const ref  = firebase.storage().ref(`users/${uid}/template/${file.name}`);
    await ref.put(file);
    const url  = await ref.getDownloadURL();
    await db.collection("users").doc(uid).update({ templateFile: url, templateFileName: file.name });
    status.textContent = "✓ Template saved: " + file.name;
    status.style.color = "#38a169";
  } catch (err) {
    status.textContent = "Upload failed: " + err.message;
    status.style.color = "#e53e3e";
  }
}

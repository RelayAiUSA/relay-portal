// ── ZOHO BOOKS OAuth Callback ─────────────────────────────────────────────
// Handles redirect from Zoho after user grants permission to Relay Ai.
// Exchanges auth code for access + refresh tokens, stores in Firestore.

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

exports.handler = async (event) => {
  const BASE = 'https://portal-relay.com';
  const { code, state: uid, error } = event.queryStringParameters || {};

  // User denied or something went wrong
  if (error || !code || !uid) {
    console.error('Zoho callback error param:', error);
    return redirect(`${BASE}/?zoho=denied`);
  }

  try {
    // ── Step 1: Exchange auth code for tokens ────────────────────────────
    const tokenRes = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri:  `${BASE}/.netlify/functions/zoho-callback`,
        code
      }).toString()
    });

    const tokens = await tokenRes.json();
    console.log('Zoho token response:', JSON.stringify(tokens));

    if (tokens.error || !tokens.access_token) {
      console.error('Token exchange failed:', tokens);
      return redirect(`${BASE}/?zoho=error`);
    }

    // ── Step 2: Get Zoho org/company info ───────────────────────────────
    let orgId = null;
    try {
      const orgRes = await fetch('https://www.zohoapis.com/books/v3/organizations', {
        headers: { Authorization: `Zoho-oauthtoken ${tokens.access_token}` }
      });
      const orgData = await orgRes.json();
      orgId = orgData.organizations?.[0]?.organization_id || null;
    } catch (e) {
      console.warn('Could not fetch Zoho org:', e.message);
    }

    // ── Step 3: Store tokens in Firestore under user's account ──────────
    const db = getDb();
    await db.collection('users').doc(uid).set({
      zoho: {
        connected:    true,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt:    Date.now() + ((tokens.expires_in || 3600) * 1000),
        orgId,
        connectedAt:  Date.now()
      },
      platform: 'zoho'
    }, { merge: true });

    return redirect(`${BASE}/?zoho=connected`);

  } catch (err) {
    console.error('Zoho callback fatal error:', err);
    return redirect(`${BASE}/?zoho=error`);
  }
};

function redirect(url) {
  return {
    statusCode: 302,
    headers: { Location: url },
    body: ''
  };
}

// ── QUICKBOOKS ONLINE OAuth Callback ─────────────────────────────────────────
// Handles redirect from QuickBooks after user grants permission to Relay Ai.
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
  const { code, state: uid, realmId, error } = event.queryStringParameters || {};

  if (error || !code || !uid) {
    console.error('QuickBooks callback error param:', error);
    return redirect(`${BASE}/?qbo=denied`);
  }

  try {
    // ── Step 1: Exchange auth code for tokens ────────────────────────────────
    const credentials = Buffer.from(
      `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`
    ).toString('base64');

    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
        'Accept':        'application/json'
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: `${BASE}/.netlify/functions/quickbooks-callback`
      }).toString()
    });

    const tokens = await tokenRes.json();
    console.log('QuickBooks token response:', JSON.stringify(tokens));

    if (tokens.error || !tokens.access_token) {
      console.error('Token exchange failed:', tokens);
      return redirect(`${BASE}/?qbo=error`);
    }

    // ── Step 2: Store tokens + realmId in Firestore ──────────────────────────
    const db = getDb();
    await db.collection('users').doc(uid).set({
      quickbooks: {
        connected:    true,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt:    Date.now() + ((tokens.expires_in || 3600) * 1000),
        realmId:      realmId || null,   // QuickBooks company ID
        connectedAt:  Date.now()
      },
      platform: 'quickbooks'
    }, { merge: true });

    return redirect(`${BASE}/?qbo=connected`);

  } catch (err) {
    console.error('QuickBooks callback fatal error:', err);
    return redirect(`${BASE}/?qbo=error`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

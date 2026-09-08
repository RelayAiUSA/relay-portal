// relay-pwa/functions/oauth-token.mjs
// Exchanges an OAuth authorization code for access + refresh tokens,
// then encrypts and persists them to Firestore.
//
// Security model:
//   - Client sends a Firebase ID token (Authorization: Bearer <idToken>)
//   - This function verifies the token server-side with Firebase Admin SDK
//   - Tokens are AES-256-GCM encrypted before storage using TOKEN_ENCRYPTION_KEY
//   - Raw tokens are never returned to the client
//
// Migrated to Netlify Functions v2 (no Lambda compat layer) to avoid 4KB env var limit.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                   from 'firebase-admin/firestore';
import { getAuth }                        from 'firebase-admin/auth';
import { encrypt }                        from './lib/token-helpers.mjs';
import { alertError }                     from './lib/alert.mjs';

// ── Firebase Admin init ───────────────────────────────────────────────────────

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db   = getFirestore();
const auth = getAuth();

// ── CORS headers ─────────────────────────────────────────────────────────────

const HEADERS = {
  'Access-Control-Allow-Origin':  'https://portal-relay.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

// ── Main handler — Netlify Functions v2 ──────────────────────────────────────

// Catch-all. Every handler below had an unguarded prologue - work that ran
// before its own try block, such as getDb() or reading the request - so an
// error there escaped with no alert at all: the function 500'd, nobody was
// told, and the failure was only discoverable by a customer complaining.
//
// This wrapper is the last line of defence. It never swallows the error
// silently: it logs, alerts, and returns a response appropriate to this
// endpoint's protocol.
export default async (req, context) => {
  try {
    return await handleOauthToken(req, context);
  } catch (err) {
    console.error('[oauth-token] unhandled error:', err);
    // An alert failure must not mask the original error.
    try {
      await alertError('oauth-token:unhandled', err);
    } catch (alertErr) {
      console.error('[oauth-token] alert failed:', alertErr?.message);
    }
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: HEADERS }
    );
  }
};

async function handleOauthToken(req, context) {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: HEADERS });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401, headers: HEADERS });
  }

  let uid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    console.error('[oauth-token] ID token verification failed:', err.message);
    return new Response(JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }), { status: 401, headers: HEADERS });
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    const rawBody = await req.text();
    body = JSON.parse(rawBody || '{}');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: HEADERS });
  }

  const { platform, code, realmId } = body;
  if (!platform || !code) {
    return new Response(JSON.stringify({ error: 'Missing platform or code' }), { status: 400, headers: HEADERS });
  }

  // ── Exchange authorization code for tokens ────────────────────────────────
  try {
    let rawTokens;
    const redirectUri = 'https://portal-relay.com/oauth-callback.html';

    if (platform === 'quickbooks') {
      const clientId     = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
      const clientSecret = process.env.INTUIT_CLIENT_SECRET;
      const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const params = new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      });

      const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method:  'POST',
        headers: {
          Authorization:  `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept:         'application/json',
        },
        body: params.toString(),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('[oauth-token] QuickBooks token error:', err);
        return new Response(JSON.stringify({ error: 'QuickBooks token exchange failed' }), { status: 502, headers: HEADERS });
      }
      const data = await resp.json();
      rawTokens = {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresIn:    data.expires_in || 3600,
        realmId:      realmId || '',
      };

    } else if (platform === 'zoho') {
      const clientId     = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
      const clientSecret = process.env.ZOHO_CLIENT_SECRET;

      const params = new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        code,
      });

      const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('[oauth-token] Zoho token error:', err);
        return new Response(JSON.stringify({ error: 'Zoho token exchange failed' }), { status: 502, headers: HEADERS });
      }
      const data = await resp.json();

      // Fetch the Zoho org ID to store alongside the token so accounting-sync
      // doesn't need to make a separate API call on every invoice.
      let organizationId = '';
      try {
        const orgResp = await fetch('https://books.zoho.com/api/v3/organizations', {
          headers: { Authorization: `Zoho-oauthtoken ${data.access_token}` },
        });
        const orgData = await orgResp.json();
        organizationId = orgData.organizations?.[0]?.organization_id || '';
      } catch (e) {
        console.warn('[oauth-token] Could not fetch Zoho org ID:', e.message);
      }

      rawTokens = {
        accessToken:    data.access_token,
        refreshToken:   data.refresh_token,
        expiresIn:      data.expires_in || 3600,
        organizationId,
      };

    } else {
      return new Response(JSON.stringify({ error: `Unknown platform: ${platform}` }), { status: 400, headers: HEADERS });
    }

    // ── Encrypt and persist tokens to Firestore ───────────────────────────
    const expiresAt  = new Date(Date.now() + rawTokens.expiresIn * 1000);
    const tokenDoc   = {
      accessToken:      encrypt(rawTokens.accessToken),
      refreshToken:     encrypt(rawTokens.refreshToken),
      expiresAt,
      connectionStatus: 'connected',
      connectedAt:      new Date(),
      lastRefreshedAt:  new Date(),
      lastRefreshError: null,
    };
    if (rawTokens.realmId)        tokenDoc.realmId        = rawTokens.realmId;
    if (rawTokens.organizationId) tokenDoc.organizationId = rawTokens.organizationId;

    const tokenRef = db.collection('users').doc(uid).collection('oauth_tokens').doc(platform);
    await tokenRef.set(tokenDoc, { merge: true });

    // Update user profile with the connected provider
    await db.collection('users').doc(uid).update({
      accountingProvider: platform,
      connectionStatus:   'connected',
      lastSyncedAt:       new Date(),
    });

    console.log(`[oauth-token] uid=${uid} connected ${platform} successfully`);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: HEADERS });

  } catch (err) {
    console.error('[oauth-token] Unhandled error:', err.message);
    await alertError('oauth-token', err, `platform=${body?.platform}`);
    return new Response(
      JSON.stringify({ error: 'Internal server error', detail: err.message }),
      { status: 500, headers: HEADERS }
    );
  }
}

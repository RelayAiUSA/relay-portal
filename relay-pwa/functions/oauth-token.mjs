// relay-pwa/functions/oauth-token.mjs
// Exchanges an OAuth authorization code for access + refresh tokens,
// then encrypts and persists them to Firestore.
//
// Security model:
//   - Client sends a Firebase ID token (Authorization: Bearer <idToken>)
//   - This function verifies the token server-side with Firebase Admin SDK
//   - Tokens are AES-256-GCM encrypted before storage using TOKEN_ENCRYPTION_KEY
//   - Raw tokens are never returned to the client

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                   from 'firebase-admin/firestore';
import { getAuth }                        from 'firebase-admin/auth';
import { withLambda }                     from '@netlify/aws-lambda-compat';
import { encrypt }                        from './lib/token-helpers.mjs';

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

// ── Main handler (withLambda: event.body is a plain string, event.headers is a plain object) ──

async function oauthTokenHandler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  let uid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    console.error('[oauth-token] ID token verification failed:', err.message);
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired session. Please sign in again.' }) };
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { platform, code, realmId } = body;
  if (!platform || !code) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing platform or code' }) };
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
        return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'QuickBooks token exchange failed' }) };
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
        return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Zoho token exchange failed' }) };
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
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Unknown platform: ${platform}` }) };
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
    return {
      statusCode: 200,
      headers:    HEADERS,
      body:       JSON.stringify({ success: true }),
    };

  } catch (err) {
    console.error('[oauth-token] Unhandled error:', err.message);
    return {
      statusCode: 500,
      headers:    HEADERS,
      body:       JSON.stringify({ error: 'Internal server error', detail: err.message }),
    };
  }
}

export const handler = withLambda(oauthTokenHandler);

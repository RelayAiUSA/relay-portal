// netlify/functions/oauth-token.js
// Handles the OAuth token exchange for QuickBooks and Zoho Books.
// Client secrets are stored as Netlify environment variables -- never in client code.
// Tokens are encrypted and written to Firestore server-side here (Admin SDK) --
// the browser never sees or stores the raw access/refresh token.

const admin = require('firebase-admin');
const { encrypt } = require('./lib/tokenHelpers');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://portal-relay.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { platform, code, realmId, uid } = body;

  if (!platform || !code || !uid) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing platform, code, or uid' }) };
  }

  // Verify the Firebase ID token so a caller can only ever write tokens into
  // their OWN account -- the uid in the body is never trusted on its own.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing auth token' }) };
  }
  let verifiedUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    verifiedUid = decoded.uid;
  } catch (err) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid auth token' }) };
  }

  try {
    let exchanged;

  if (platform === 'quickbooks') {
    const clientId = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
    const clientSecret = process.env.INTUIT_CLIENT_SECRET;
    const redirectUri = 'https://portal-relay.com/oauth-callback.html';
    const credentials = Buffer.from(clientId + ':' + clientSecret).toString('base64');

    const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('QuickBooks token error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'QuickBooks token exchange failed', detail: err }) };
    }
    const data = await resp.json();
    exchanged = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in, realmId: realmId || '' };

  } else if (platform === 'zoho') {
    const clientId = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    const redirectUri = 'https://portal-relay.com/oauth-callback.html';

    const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code: code,
      }).toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Zoho token error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Zoho token exchange failed', detail: err }) };
    }
    const data = await resp.json();
    exchanged = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };

  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown platform: ' + platform }) };
  }

  // Encrypt and write server-side. The client never handles raw tokens.
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + exchanged.expiresIn * 1000);
    await db.collection('users').doc(verifiedUid).collection('oauth_tokens').doc(platform).set({
      accessToken: encrypt(exchanged.accessToken),
      refreshToken: encrypt(exchanged.refreshToken),
      realmId: exchanged.realmId || '',
      expiresAt,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  await db.collection('users').doc(verifiedUid).update({
    platform,
    accountingProvider: platform,
    connectionStatus: 'connected',
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, platform }) };

  } catch (err) {
    console.error('oauth-token function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', detail: err.message }) };
  }
};

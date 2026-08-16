// netlify/functions/lib/tokenHelpers.js
// Shared helpers for the per-customer OAuth token system.
// Encrypts/decrypts tokens at rest and handles the refresh-token exchange
// for Zoho Books and QuickBooks. Used by oauth-token.js and the daily
// oauth-refresh-sweep.js scheduled function.

const crypto = require('crypto');
const admin = require('firebase-admin');

// 32-byte hex key, set as a Netlify env var: openssl rand -hex 32
const ENCRYPTION_KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
const ALGO = 'aes-256-gcm';

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    data: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decrypt({ data, iv, authTag }) {
  const decipher = crypto.createDecipheriv(ALGO, ENCRYPTION_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
    ]);
  return decrypted.toString('utf8');
}

// Provider-specific refresh calls. Each takes a decrypted refresh token
// and returns { accessToken, refreshToken, expiresIn (seconds) }.
const PROVIDER_REFRESH = {
  zoho: async (refreshToken) => {
    const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L',
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    if (!resp.ok) throw new Error('Zoho refresh failed: ' + resp.status + ' ' + (await resp.text()));
    const json = await resp.json();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || refreshToken,
      expiresIn: json.expires_in,
    };
  },

  quickbooks: async (refreshToken) => {
    const clientId = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
    const credentials = Buffer.from(clientId + ':' + process.env.INTUIT_CLIENT_SECRET).toString('base64');
    const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!resp.ok) throw new Error('QuickBooks refresh failed: ' + resp.status + ' ' + (await resp.text()));
    const json = await resp.json();
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresIn: json.expires_in,
    };
  },
};

// Refreshes one customer's token for a provider. Updates Firestore with
// the new encrypted token + expiresAt, and keeps connectionStatus on the
// parent user doc accurate. Returns true on success, false on failure.
async function refreshCustomerToken(db, uid, provider) {
  const tokenRef = db.collection('users').doc(uid).collection('oauth_tokens').doc(provider);
  const userRef = db.collection('users').doc(uid);

const tokenSnap = await tokenRef.get();
  if (!tokenSnap.exists) {
    await userRef.update({ connectionStatus: 'not_connected' });
    return false;
  }

const tokenData = tokenSnap.data();
  const refreshTokenPlain = decrypt(tokenData.refreshToken);

try {
  const refreshed = await PROVIDER_REFRESH[provider](refreshTokenPlain);
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + refreshed.expiresIn * 1000);

  await tokenRef.update({
    accessToken: encrypt(refreshed.accessToken),
    refreshToken: encrypt(refreshed.refreshToken),
    expiresAt,
    refreshedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await userRef.update({
    connectionStatus: 'connected',
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastErrorAt: null,
    lastErrorMessage: null,
  });

  return true;
} catch (err) {
  const isTerminal = /invalid_grant|revoked|unauthorized/i.test(err.message || '');
  await userRef.update({
    connectionStatus: isTerminal ? 'revoked' : 'error',
    lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
    lastErrorMessage: err.message,
  });
  return false;
}
}

module.exports = { encrypt, decrypt, refreshCustomerToken, PROVIDER_REFRESH };

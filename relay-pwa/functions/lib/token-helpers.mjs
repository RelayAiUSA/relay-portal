// relay-pwa/functions/lib/token-helpers.mjs
// AES-256-GCM token encryption + OAuth refresh helpers for Zoho Books and QuickBooks.
//
// Required env vars:
//   TOKEN_ENCRYPTION_KEY   — 32-byte hex string (openssl rand -hex 32)
//   ZOHO_CLIENT_SECRET     — Zoho OAuth app client secret
//   INTUIT_CLIENT_SECRET   — QuickBooks OAuth app client secret

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ── Encryption ────────────────────────────────────────────────────────────────

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (hex.length !== 64) throw new Error('TOKEN_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)');
  return Buffer.from(hex, 'hex');
}

export function encrypt(plainText) {
  // A missing token used to reach createCipheriv().update(undefined) and throw
  // 'The "data" argument must be of type string... Received undefined', which
  // says nothing about which token was missing or why. Fail with the actual
  // problem instead.
  if (typeof plainText !== 'string' || !plainText) {
    throw new Error('encrypt() received an empty or non-string value - the provider did not return this token');
  }
  const key = getKey();
  const iv  = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return {
    data:    encrypted.toString('base64'),
    iv:      iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decrypt({ data, iv, authTag }) {
  const key = getKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ── OAuth refresh config ───────────────────────────────────────────────────────

export const PROVIDER_REFRESH = {
  zoho: {
    clientId:     '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L',
    clientSecret: () => process.env.ZOHO_CLIENT_SECRET,
    endpoint:     'https://accounts.zoho.com/oauth/v2/token',
    buildParams:  (refreshToken) => new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L',
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  },
  quickbooks: {
    clientId:     'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr',
    clientSecret: () => process.env.INTUIT_CLIENT_SECRET,
    endpoint:     'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    buildParams:  (refreshToken) => new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
    buildHeaders: () => {
      const creds = Buffer.from(
        `AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr:${process.env.INTUIT_CLIENT_SECRET}`
      ).toString('base64');
      return { Authorization: `Basic ${creds}` };
    },
  },
};

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch a valid access token for the given user and provider.
 * Auto-refreshes if the token is within 5 minutes of expiry.
 * Returns { accessToken, realmId?, organizationId? } or null if not connected / revoked.
 */
export async function ensureFreshToken(db, uid, provider) {
  const tokenRef = db.collection('users').doc(uid).collection('oauth_tokens').doc(provider);
  const snap     = await tokenRef.get();
  if (!snap.exists) return null;

  const data = snap.data();
  if (data.connectionStatus === 'revoked') return null;

  // Check expiry (5-minute buffer)
  const expiresAtMs = data.expiresAt?.toMillis?.() || (data.expiresAt?._seconds * 1000) || 0;
  const needsRefresh = expiresAtMs - Date.now() < 5 * 60 * 1000;

  if (needsRefresh) {
    const ok = await refreshCustomerToken(db, uid, provider);
    if (!ok) return null;
    const fresh = await tokenRef.get();
    const fd = fresh.data();
    return {
      accessToken:    decrypt(fd.accessToken),
      realmId:        fd.realmId,
      organizationId: fd.organizationId,
    };
  }

  return {
    accessToken:    decrypt(data.accessToken),
    realmId:        data.realmId,
    organizationId: data.organizationId,
  };
}

/**
 * Refresh the OAuth access token for the given provider.
 * Updates Firestore with the new token (encrypted).
 * Sets connectionStatus to 'revoked' if refresh fails with a terminal error.
 * Returns true on success, false on failure.
 */
export async function refreshCustomerToken(db, uid, provider) {
  const tokenRef = db.collection('users').doc(uid).collection('oauth_tokens').doc(provider);
  const snap     = await tokenRef.get();
  if (!snap.exists) return false;

  const data         = snap.data();
  const config       = PROVIDER_REFRESH[provider];
  if (!config) return false;

  let refreshToken;
  try {
    refreshToken = decrypt(data.refreshToken);
  } catch (err) {
    console.error(`[token-helpers] Decrypt failed for ${uid}/${provider}:`, err.message);
    return false;
  }

  try {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(config.buildHeaders?.() || {}),
    };
    const resp = await fetch(config.endpoint, {
      method:  'POST',
      headers,
      body:    config.buildParams(refreshToken).toString(),
    });
    const json = await resp.json();

    if (!resp.ok) {
      const errCode = (json.error || '').toLowerCase();
      if (['invalid_grant', 'revoked', 'unauthorized'].includes(errCode)) {
        await tokenRef.update({ connectionStatus: 'revoked' });
        await db.collection('users').doc(uid).update({ connectionStatus: 'revoked' });
      } else {
        await tokenRef.update({ connectionStatus: 'error', lastRefreshError: json.error || 'unknown' });
      }
      return false;
    }

    const newAccessToken  = encrypt(json.access_token);
    // Zoho returns a new refresh token on every refresh; QB returns a new one after 24h
    const newRefreshToken = json.refresh_token ? encrypt(json.refresh_token) : data.refreshToken;
    const expiresInSecs   = json.expires_in || 3600;
    const expiresAt       = new Date(Date.now() + expiresInSecs * 1000);

    await tokenRef.update({
      accessToken:     newAccessToken,
      refreshToken:    newRefreshToken,
      expiresAt,
      connectionStatus: 'connected',
      lastRefreshedAt:  new Date(),
      lastRefreshError: null,
    });
    await db.collection('users').doc(uid).update({
      connectionStatus: 'connected',
      lastSyncedAt:     new Date(),
    });
    return true;
  } catch (err) {
    console.error(`[token-helpers] Refresh error for ${uid}/${provider}:`, err.message);
    return false;
  }
}

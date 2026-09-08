// relay-pwa/functions/oauth-refresh-sweep.mjs
// Scheduled function (see netlify.toml) — runs daily. Walks every customer's
// oauth_tokens, refreshes anything close to expiring, and makes sure
// connectionStatus reflects reality, so a broken Zoho/QuickBooks connection
// is caught here instead of the next time an invoice silently fails to sync.
//
// Ported from netlify/functions/oauth-refresh-sweep.js (CommonJS). The old
// file lived outside the configured functions directory, so the schedule in
// netlify.toml pointed at a function that was never deployed — token refresh
// had never actually run.
//
// Migrated to Netlify Functions v2 (ESM) to match the other functions, and
// switched off the twilio SDK, whose dynamic requires break esbuild bundling.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { refreshCustomerToken }          from './lib/token-helpers.mjs';
import { alertError }                    from './lib/alert.mjs';

// Firebase Admin — lazy singleton with duplicate-init guard
let _db;
function getDb() {
  if (!_db) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    }
    _db = getFirestore();
  }
  return _db;
}

const REFRESH_WINDOW_MS = 60 * 60 * 1000; // refresh if expiring within 1 hour

// Twilio via plain fetch — no SDK.
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER || '+18447291376';
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || JSON.stringify(data)}`);
  return data.sid;
}

// Fires when a customer's connection is confirmed broken. Two things happen:
// an internal alert, and a customer-facing SMS telling them to reconnect, so
// an invoice never silently fails without anyone knowing.
async function notifyBrokenConnection(db, uid, user, provider) {
  const label = provider === 'quickbooks' ? 'QuickBooks' : 'Zoho Books';
  console.error(
    `ALERT: user ${uid} (${user.companyName || 'unknown'}) has a broken ` +
    `${provider} connection and needs to reconnect.`
  );

  // Surface it in the dashboard too, not just in logs.
  try {
    await db.collection('users').doc(uid).update({
      connectionStatus:    'needs_reconnect',
      connectionBrokenAt:  new Date(),
    });
  } catch (err) {
    console.error('[oauth-refresh-sweep] Could not flag user doc:', err.message);
  }

  if (!user.phoneNumber) return;
  try {
    await sendSms(
      user.phoneNumber,
      `Your ${label} connection to Relay needs to be reconnected so invoices ` +
      `keep syncing. Visit portal-relay.com to reconnect.`
    );
  } catch (err) {
    console.error('[oauth-refresh-sweep] Broken-connection SMS failed:', err.message);
  }
}

export default async (req, context) => {
  const db      = getDb();
  const results = { refreshed: 0, skipped: 0, failed: 0, total: 0 };

  try {
    const usersSnap = await db.collection('users').get();
    results.total = usersSnap.size;

    for (const userDoc of usersSnap.docs) {
      const user = userDoc.data();
      if (user.connectionStatus === 'not_connected' || !user.accountingProvider) {
        results.skipped++;
        continue;
      }

      const tokensSnap = await userDoc.ref.collection('oauth_tokens').get();

      for (const tokenDoc of tokensSnap.docs) {
        const provider = tokenDoc.id; // "zoho" or "quickbooks"
        const { expiresAt } = tokenDoc.data();
        const expiresAtMs = expiresAt?.toMillis ? expiresAt.toMillis() : 0;

        if (expiresAtMs - Date.now() >= REFRESH_WINDOW_MS) {
          results.skipped++;
          continue;
        }

        let ok = false;
        try {
          ok = await refreshCustomerToken(db, userDoc.id, provider);
        } catch (err) {
          console.error(`[oauth-refresh-sweep] refresh threw for ${userDoc.id}/${provider}:`, err.message);
        }

        if (ok) {
          results.refreshed++;
        } else {
          results.failed++;
          await notifyBrokenConnection(db, userDoc.id, user, provider);
        }
      }
    }

    console.log('[oauth-refresh-sweep] complete:', results);
    return Response.json(results);
  } catch (err) {
    console.error('[oauth-refresh-sweep] fatal:', err);
    await alertError('oauth-refresh-sweep', err);
    return new Response(err.message, { status: 500 });
  }
};

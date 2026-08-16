// netlify/functions/oauth-refresh-sweep.js
// Scheduled function (see netlify.toml) -- runs daily. Walks every customer's
// oauth_tokens, refreshes anything close to expiring, and makes sure
// connectionStatus reflects reality, so a broken Zoho/QuickBooks connection
// is caught here instead of the next time an invoice silently fails to sync.

const admin = require('firebase-admin');
const { refreshCustomerToken } = require('./lib/tokenHelpers');

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

const REFRESH_WINDOW_MS = 60 * 60 * 1000; // refresh if expiring within 1 hour

exports.handler = async function() {
  const usersSnap = await db.collection('users').get();
  const results = { refreshed: 0, skipped: 0, failed: 0, total: usersSnap.size };

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
    const expiresAtMs = expiresAt ? expiresAt.toMillis() : 0;
    const needsRefresh = expiresAtMs - Date.now() < REFRESH_WINDOW_MS;

    if (!needsRefresh) {
      results.skipped++;
      continue;
    }

    const ok = await refreshCustomerToken(db, userDoc.id, provider);
    if (ok) {
      results.refreshed++;
    } else {
      results.failed++;
      await notifyBrokenConnection(userDoc.id, user, provider);
    }
  }
  }

  console.log('Daily OAuth token sweep complete:', results);
  return { statusCode: 200, body: JSON.stringify(results) };
};

// Fires when a customer's connection is confirmed broken. Two things
// happen: an internal alert (console.error, visible in Netlify function
// logs -- wire to Slack/email if you want it pushed to you), and a
// customer-facing SMS via the existing Twilio number telling them to
// reconnect, so an invoice never silently fails without anyone knowing.
async function notifyBrokenConnection(uid, user, provider) {
  console.error(
    'ALERT: user ' + uid + ' (' + (user.companyName || 'unknown') + ') ' +
    'has a broken ' + provider + ' connection and needs to reconnect.'
    );

if (!user.phoneNumber) return;

try {
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const label = provider === 'quickbooks' ? 'QuickBooks' : 'Zoho Books';
  await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER || '+18447291376',
    to: user.phoneNumber,
    body: 'Your ' + label + ' connection to Relay needs to be reconnected so invoices keep syncing. Visit portal-relay.com to reconnect.',
  });
} catch (err) {
  console.error('Failed to send broken-connection SMS:', err);
}
}

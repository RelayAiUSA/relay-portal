// ── SMS INBOUND — Relay Ai Essential Tier ─────────────────────────────────────
// Receives structured SMS from Twilio, creates a QuickBooks invoice, confirms by text.
//
// FORMAT: INVOICE | Customer Name | Job Description | $Amount
// EXAMPLE: INVOICE | Mike Johnson | Water heater replacement | $850
//
// ENV VARS REQUIRED:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
//   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET
//   QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET
//   FIREBASE_ADMIN_CREDENTIALS

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore }                  = require('firebase-admin/firestore');
const twilio                            = require('twilio');

// ── Firebase ─────────────────────────────────────────────────────────────────
function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

// ── TwiML response helper ─────────────────────────────────────────────────────
const twiml = (msg) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/xml' },
  body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(msg)}</Message></Response>`
});

function escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Parse structured SMS ──────────────────────────────────────────────────────
// Accepts: INVOICE | Customer Name | Description | $850
// Also accepts lowercase, extra spaces, dollar sign optional
function parseMessage(raw) {
  const parts = raw.split('|').map(s => s.trim());
  if (parts.length < 4) return null;

  const [cmd, customerName, description, amountStr] = parts;
  if (!cmd.toUpperCase().replace(/\s/g,'').startsWith('INVOICE')) return null;

  if (!customerName || customerName.length < 2) return null;
  if (!description  || description.length < 2)  return null;

  const amount = parseFloat(amountStr.replace(/[^0-9.]/g, ''));
  if (isNaN(amount) || amount <= 0) return null;

  return { customerName, description, amount };
}

// ── QB: refresh access token if expired ──────────────────────────────────────
async function getValidQBToken(db, uid, qbData) {
  // Return current token if it has more than 1 minute left
  if (Date.now() < (qbData.expiresAt - 60000)) {
    return qbData.accessToken;
  }

  const credentials = Buffer.from(
    `${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
      'Accept':        'application/json'
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: qbData.refreshToken
    }).toString()
  });

  const tokens = await res.json();
  if (!tokens.access_token) throw new Error(`QB token refresh failed: ${JSON.stringify(tokens)}`);

  // Persist new tokens
  await db.collection('users').doc(uid).update({
    'quickbooks.accessToken':  tokens.access_token,
    'quickbooks.refreshToken': tokens.refresh_token || qbData.refreshToken,
    'quickbooks.expiresAt':    Date.now() + ((tokens.expires_in || 3600) * 1000)
  });

  return tokens.access_token;
}

// ── QB: find or create customer ───────────────────────────────────────────────
async function findOrCreateCustomer(realmId, token, displayName) {
  const base    = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };

  // Search first
  const safeName = displayName.replace(/'/g, "\\'");
  const q        = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${safeName}' MAXRESULTS 1`);
  const search   = await fetch(`${base}/query?query=${q}&minorversion=65`, { headers });
  const sd       = await search.json();
  const existing = sd?.QueryResponse?.Customer;
  if (existing?.length) return existing[0].Id;

  // Create new
  const create = await fetch(`${base}/customer?minorversion=65`, {
    method: 'POST', headers,
    body: JSON.stringify({ DisplayName: displayName })
  });
  const cd = await create.json();
  const id = cd?.Customer?.Id;
  if (!id) throw new Error(`QB customer create failed: ${JSON.stringify(cd)}`);
  return id;
}

// ── QB: get first service item ID ─────────────────────────────────────────────
// QuickBooks requires an ItemRef on line items. We grab the first active
// Service or NonInventory item, or fall back to creating a "Relay Services" item.
async function getServiceItemId(realmId, token) {
  const base    = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };

  const q    = encodeURIComponent(`SELECT * FROM Item WHERE Type IN ('Service','NonInventory') AND Active = true MAXRESULTS 1`);
  const res  = await fetch(`${base}/query?query=${q}&minorversion=65`, { headers });
  const data = await res.json();
  const item = data?.QueryResponse?.Item;
  if (item?.length) return item[0].Id;

  // No service item found — create one called "Relay Services"
  const create = await fetch(`${base}/item?minorversion=65`, {
    method: 'POST', headers,
    body: JSON.stringify({
      Name:              'Relay Services',
      Type:              'Service',
      IncomeAccountRef:  { name: 'Services', value: '1' }
    })
  });
  const cd = await create.json();
  return cd?.Item?.Id || null;
}

// ── QB: create invoice ────────────────────────────────────────────────────────
async function createInvoice(realmId, token, customerId, itemId, description, amount) {
  const base    = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };

  const body = {
    CustomerRef: { value: customerId },
    Line: [{
      Amount:      amount,
      DetailType:  'SalesItemLineDetail',
      Description: description,
      SalesItemLineDetail: {
        ItemRef:    { value: itemId },
        UnitPrice:  amount,
        Qty:        1
      }
    }]
  };

  const res  = await fetch(`${base}/invoice?minorversion=65`, {
    method: 'POST', headers,
    body: JSON.stringify(body)
  });
  const data = await res.json();
  const inv  = data?.Invoice;
  if (!inv?.Id) throw new Error(`QB invoice create failed: ${JSON.stringify(data)}`);

  return { id: inv.Id, docNumber: inv.DocNumber, total: inv.TotalAmt };
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const params    = new URLSearchParams(event.body || '');
  const fromPhone = params.get('From')  || '';
  const rawBody   = (params.get('Body') || '').trim();

  // ── Validate Twilio signature ────────────────────────────────────────────
  const sig = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'] || '';
  const url = 'https://portal-relay.com/.netlify/functions/sms-inbound';
  const paramObj = Object.fromEntries(params.entries());

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    sig,
    url,
    paramObj
  );

  if (!isValid) {
    console.error('Invalid Twilio signature — request rejected');
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (!fromPhone || !rawBody) {
    return twiml('Could not read your message. Please try again.');
  }

  console.log(`SMS from ${fromPhone}: ${rawBody}`);

  // ── Help message ─────────────────────────────────────────────────────────
  if (rawBody.toUpperCase() === 'HELP') {
    return twiml(
      'Relay Ai — Invoice by text\n\n' +
      'Format:\nINVOICE | Customer Name | Job Description | $Amount\n\n' +
      'Example:\nINVOICE | Mike Johnson | Water heater replacement | $850\n\n' +
      'Need help? Visit portal-relay.com'
    );
  }

  const db = getDb();

  try {
    // ── 1. Look up Relay account by sender phone ─────────────────────────
    const regSnap = await db.collection('phone_registry').doc(fromPhone).get();
    if (!regSnap.exists) {
      return twiml(
        'This number is not registered with Relay Ai.\n\n' +
        'Log in at portal-relay.com → Account & Settings → add your Business Phone Number, then save.'
      );
    }
    const { uid, companyName } = regSnap.data();

    // ── 2. Parse the message ─────────────────────────────────────────────
    const parsed = parseMessage(rawBody);
    if (!parsed) {
      return twiml(
        'Format not recognized. Please use:\n\n' +
        'INVOICE | Customer Name | Description | $Amount\n\n' +
        'Text HELP for more info.'
      );
    }
    const { customerName, description, amount } = parsed;

    // ── 3. Load user profile + QB tokens ─────────────────────────────────
    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};
    const qbData   = userData.quickbooks;

    if (!qbData?.connected || !qbData?.realmId) {
      return twiml(
        'Your QuickBooks account is not connected.\n\n' +
        'Log in at portal-relay.com → Account & Settings → connect QuickBooks.'
      );
    }

    // ── 4. Refresh QB token if needed ────────────────────────────────────
    const token = await getValidQBToken(db, uid, qbData);

    // ── 5. Find or create QB customer ────────────────────────────────────
    const customerId = await findOrCreateCustomer(qbData.realmId, token, customerName);

    // ── 6. Get a service item for the line ───────────────────────────────
    const itemId = await getServiceItemId(qbData.realmId, token);
    if (!itemId) throw new Error('No service item found and could not create one');

    // ── 7. Create invoice in QB ──────────────────────────────────────────
    const invoice = await createInvoice(qbData.realmId, token, customerId, itemId, description, amount);

    // ── 8. Log invoice in Firestore ──────────────────────────────────────
    await db.collection('users').doc(uid).collection('invoices').add({
      customerName,
      description,
      amount,
      qbInvoiceId:  invoice.id,
      qbDocNumber:  invoice.docNumber,
      status:       'pending',
      source:       'sms',
      fromPhone,
      createdAt:    new Date().toISOString()
    });

    // ── 9. Confirm back to sender ─────────────────────────────────────────
    return twiml(
      `Invoice #${invoice.docNumber} created!\n\n` +
      `Customer: ${customerName}\n` +
      `Job: ${description}\n` +
      `Amount: $${amount.toFixed(2)}\n\n` +
      `Synced to QuickBooks`
    );

  } catch (err) {
    console.error('sms-inbound fatal error:', err);
    return twiml(
      'Something went wrong creating your invoice. Please try again or log in at portal-relay.com.'
    );
  }
};

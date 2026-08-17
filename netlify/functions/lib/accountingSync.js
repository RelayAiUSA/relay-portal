// netlify/functions/lib/accountingSync.js
// Takes a Relay invoice (already saved to Firestore) and creates the real
// invoice in the customer's connected accounting software (Zoho Books or
// QuickBooks). Never throws -- always returns a result object, so a sync
// failure never breaks the SMS reply to the tradesperson.

const admin = require('firebase-admin');
const { ensureFreshToken } = require('./tokenHelpers');

const ZOHO_API_BASE = 'https://www.zohoapis.com/books/v3';
const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';

// ── Zoho Books ──────────────────────────────────────────────────────────────────────

// Zoho Books requires an organization_id on every call. The OAuth connect
// flow doesn't capture it, so we fetch it once on first sync and cache it
// on the token doc so every future sync skips this extra request.
async function getZohoOrganizationId(accessToken, db, uid) {
  const tokenRef = db.collection('users').doc(uid).collection('oauth_tokens').doc('zoho');
  const snap = await tokenRef.get();
  const cached = snap.exists ? snap.data().organizationId : null;
  if (cached) return cached;

  const resp = await fetch(`${ZOHO_API_BASE}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Zoho organizations fetch failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();
  const orgId = json.organizations && json.organizations[0] && json.organizations[0].organization_id;
  if (!orgId) throw new Error('No Zoho Books organization found on this account');

  await tokenRef.update({ organizationId: orgId });
  return orgId;
}

async function findOrCreateZohoContact(accessToken, orgId, invoiceData) {
  const headers = { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' };

  if (invoiceData.customer) {
    const searchResp = await fetch(
      `${ZOHO_API_BASE}/contacts?organization_id=${orgId}&contact_name_contains=${encodeURIComponent(invoiceData.customer)}`,
      { headers }
    );
    if (searchResp.ok) {
      const searchJson = await searchResp.json();
      if (searchJson.contacts && searchJson.contacts.length > 0) {
        return searchJson.contacts[0].contact_id;
      }
    }
  }

  const createResp = await fetch(`${ZOHO_API_BASE}/contacts?organization_id=${orgId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contact_name: invoiceData.customer || 'Relay Customer',
      contact_persons: [{
        email: invoiceData.email || undefined,
        phone: invoiceData.phone || undefined,
        is_primary_contact: true,
      }],
    }),
  });
  if (!createResp.ok) throw new Error(`Zoho contact creation failed: ${createResp.status} ${await createResp.text()}`);
  const createJson = await createResp.json();
  return createJson.contact.contact_id;
}

async function createZohoInvoice(db, uid, invoiceData) {
  const token = await ensureFreshToken(db, uid, 'zoho');
  if (!token) return { synced: false, reason: 'not_connected' };

  const orgId = token.organizationId || await getZohoOrganizationId(token.accessToken, db, uid);
  const headers = { Authorization: `Zoho-oauthtoken ${token.accessToken}`, 'Content-Type': 'application/json' };

  const contactId = await findOrCreateZohoContact(token.accessToken, orgId, invoiceData);

  const resp = await fetch(`${ZOHO_API_BASE}/invoices?organization_id=${orgId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customer_id: contactId,
      line_items: [{
        name: invoiceData.type === 'quote' ? 'Quote' : 'Service',
        description: invoiceData.work || invoiceData.rawSms || '',
        rate: invoiceData.amount || 0,
        quantity: 1,
      }],
    }),
  });
  if (!resp.ok) throw new Error(`Zoho invoice creation failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();

  return {
    synced: true,
    provider: 'zoho',
    externalId: json.invoice.invoice_id,
    externalNumber: json.invoice.invoice_number,
    externalUrl: `https://books.zoho.com/app#/invoices/${json.invoice.invoice_id}`,
  };
}

// ── QuickBooks ─────────────────────────────────────────────────────────────────────

async function findOrCreateQuickBooksCustomer(accessToken, realmId, invoiceData) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const name = (invoiceData.customer || 'Relay Customer').replace(/'/g, "\\'");

  const queryResp = await fetch(
    `${QBO_API_BASE}/${realmId}/query?query=${encodeURIComponent(`select * from Customer where DisplayName = '${name}'`)}`,
    { headers }
  );
  if (queryResp.ok) {
    const queryJson = await queryResp.json();
    const existing = queryJson.QueryResponse && queryJson.QueryResponse.Customer && queryJson.QueryResponse.Customer[0];
    if (existing) return existing.Id;
  }

  const body = { DisplayName: invoiceData.customer || 'Relay Customer' };
  if (invoiceData.email) body.PrimaryEmailAddr = { Address: invoiceData.email };
  if (invoiceData.phone) body.PrimaryPhone = { FreeFormNumber: invoiceData.phone };

  const createResp = await fetch(`${QBO_API_BASE}/${realmId}/customer`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!createResp.ok) throw new Error(`QuickBooks customer creation failed: ${createResp.status} ${await createResp.text()}`);
  const createJson = await createResp.json();
  return createJson.Customer.Id;
}

// QuickBooks invoice lines require a reference to an existing Item in the
// customer's own QBO catalog -- we can't invoice against nothing. Try to
// find any active Service item; fall back to QBO's near-universal default
// "Services" item (id 1) if the query comes back empty.
async function getDefaultQuickBooksItem(accessToken, realmId) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const resp = await fetch(
    `${QBO_API_BASE}/${realmId}/query?query=${encodeURIComponent(`select * from Item where Type = 'Service' maxresults 1`)}`,
    { headers }
  );
  if (resp.ok) {
    const json = await resp.json();
    const item = json.QueryResponse && json.QueryResponse.Item && json.QueryResponse.Item[0];
    if (item) return { value: item.Id, name: item.Name };
  }
  return { value: '1', name: 'Services' };
}

async function createQuickBooksInvoice(db, uid, invoiceData) {
  const token = await ensureFreshToken(db, uid, 'quickbooks');
  if (!token || !token.realmId) return { synced: false, reason: 'not_connected' };

  const headers = { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };

  const customerId = await findOrCreateQuickBooksCustomer(token.accessToken, token.realmId, invoiceData);
  const item = await getDefaultQuickBooksItem(token.accessToken, token.realmId);

  const resp = await fetch(`${QBO_API_BASE}/${token.realmId}/invoice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      CustomerRef: { value: customerId },
      Line: [{
        Amount: invoiceData.amount || 0,
        DetailType: 'SalesItemLineDetail',
        Description: invoiceData.work || invoiceData.rawSms || '',
        SalesItemLineDetail: { ItemRef: item },
      }],
    }),
  });
  if (!resp.ok) throw new Error(`QuickBooks invoice creation failed: ${resp.status} ${await resp.text()}`);
  const json = await resp.json();

  return {
    synced: true,
    provider: 'quickbooks',
    externalId: json.Invoice.Id,
    externalNumber: json.Invoice.DocNumber || json.Invoice.Id,
    externalUrl: `https://app.qbo.intuit.com/app/invoice?txnId=${json.Invoice.Id}`,
  };
}

// ── Entry point ────────────────────────────────────────────────────────────────

// Call this right after saving a Relay invoice to Firestore. Looks at the
// customer's connected accountingProvider, creates the real invoice there,
// and writes the sync result back onto the Relay invoice doc. Never throws --
// a sync failure should never break the SMS reply to the tradesperson.
async function syncInvoiceToAccounting(db, uid, invoiceId, invoiceData, profile) {
  const invoiceRef = db.collection('users').doc(uid).collection('invoices').doc(invoiceId);
  const provider = (profile.accountingProvider || '').toLowerCase();

  if (!provider) {
    await invoiceRef.update({ accountingSync: { status: 'not_connected' } });
    return { synced: false, reason: 'not_connected' };
  }

  try {
    const result =
      provider === 'quickbooks' ? await createQuickBooksInvoice(db, uid, invoiceData) :
      provider === 'zoho' ? await createZohoInvoice(db, uid, invoiceData) :
      { synced: false, reason: 'unknown_provider' };

    if (result.synced) {
      await invoiceRef.update({
        accountingSync: {
          status: 'synced',
          provider: result.provider,
          externalId: result.externalId,
          externalNumber: result.externalNumber || null,
          externalUrl: result.externalUrl || null,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
    } else {
      await invoiceRef.update({ accountingSync: { status: result.reason || 'skipped' } });
    }
    return result;
  } catch (err) {
    console.error(`Accounting sync failed for uid=${uid} invoice=${invoiceId}:`, err);
    await invoiceRef.update({
      accountingSync: {
        status: 'failed',
        error: err.message,
        attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
    return { synced: false, reason: 'error', error: err.message };
  }
}

module.exports = { syncInvoiceToAccounting };

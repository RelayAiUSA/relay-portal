// relay-pwa/functions/lib/accounting-sync.mjs
// Syncs a Relay invoice to the tradesperson's Zoho Books or QuickBooks account.
//
// Entry point: syncInvoiceToAccounting(db, uid, invoiceId, invoiceData, profile)
// Never throws — errors are caught and written back to the invoice doc.

import { ensureFreshToken } from './token-helpers.mjs';

// ── Zoho Books ────────────────────────────────────────────────────────────────

// Every Zoho call used to read `data.organizations` (or `data.invoice`) straight
// off the parsed body without ever looking at the HTTP status. A 401 from an
// expired token or a scope the app was never granted therefore surfaced as
// "No Zoho organization found" - a message that sends you looking for a missing
// organization when the account has one and the request was simply refused.
//
// This helper makes every failure carry the status and Zoho's own message.
const ZOHO_API = 'https://www.zohoapis.com/books/v3';

async function zohoApi(path, accessToken, options = {}) {
  const url  = `${ZOHO_API}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Zoho ${path} returned ${resp.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }

  // Zoho signals application errors with a non-zero `code` even on HTTP 200.
  if (!resp.ok || (data.code !== undefined && data.code !== 0)) {
    const detail = data.message || text.slice(0, 200);
    const hint = resp.status === 401
      ? ' (the connection was refused - reconnect Zoho Books from the portal to re-authorize)'
      : '';
    throw new Error(`Zoho ${path} failed [HTTP ${resp.status}, code ${data.code}]: ${detail}${hint}`);
  }

  return data;
}

async function getZohoOrgId(accessToken) {
  const data = await zohoApi('/organizations', accessToken);
  const org  = data.organizations?.[0];
  if (!org) {
    throw new Error('Zoho returned no organizations for this login. Create a Zoho Books organization, or reconnect with the account that owns one.');
  }
  return org.organization_id;
}

async function findOrCreateZohoContact(accessToken, orgId, invoiceData) {
  const phone    = (invoiceData.customer_phone || '').replace(/\D/g, '');
  const custName = invoiceData.customer_name || 'Customer';

  // Try to find by phone first (custom field match is unreliable in free tier — search by name)
  const searchData = await zohoApi(
    `/contacts?organization_id=${orgId}&contact_name=${encodeURIComponent(custName)}`,
    accessToken
  );
  if (searchData.contacts?.length > 0) return searchData.contacts[0].contact_id;

  // Create contact
  const body = {
    contact_name: custName,
    contact_type: 'customer',
    billing_address: invoiceData.address ? { address: invoiceData.address } : undefined,
    contact_persons: [{ phone }].filter(p => p.phone),
    notes: invoiceData.customer_email ? `Email: ${invoiceData.customer_email}` : undefined,
  };
  const createData = await zohoApi(
    `/contacts?organization_id=${orgId}`,
    accessToken,
    { method: 'POST', body: JSON.stringify(body) }
  );
  if (!createData.contact?.contact_id) {
    throw new Error('Zoho accepted the contact request but returned no contact: ' + JSON.stringify(createData).slice(0, 300));
  }
  return createData.contact.contact_id;
}

async function createZohoInvoice(db, uid, invoiceData) {
  const tokens = await ensureFreshToken(db, uid, 'zoho');
  if (!tokens) throw new Error('Zoho not connected or token revoked');
  const { accessToken, accountEmail } = tokens;

  let orgId = tokens.organizationId;
  if (!orgId) {
    try {
      orgId = await getZohoOrgId(accessToken);
    } catch (err) {
      // Say which Zoho login this connection belongs to. Without it the error
      // reads as a Relay fault when the real cause is that the contractor
      // authorized with the wrong Zoho account.
      const who = accountEmail ? ` The connection is authorized as ${accountEmail}.` : '';
      throw new Error(`${err.message}${who}`);
    }
  }
  const contactId = await findOrCreateZohoContact(accessToken, orgId, invoiceData);

  const amount      = parseFloat(invoiceData.amount) || 0;
  const description = invoiceData.professional_description || invoiceData.job_type || 'Service';

  const invoiceBody = {
    customer_id: contactId,
    line_items: [{
      name:        description,
      description: `${description}${invoiceData.address ? ' at ' + invoiceData.address : ''}`,
      quantity:    1,
      rate:        amount,
    }],
    notes: `Invoice sent via Relay | Customer: ${invoiceData.customer_name || ''} | ${invoiceData.customer_phone || ''}`,
  };

  const data = await zohoApi(
    `/invoices?organization_id=${orgId}`,
    accessToken,
    { method: 'POST', body: JSON.stringify(invoiceBody) }
  );
  if (!data.invoice) {
    throw new Error('Zoho accepted the invoice request but returned no invoice: ' + JSON.stringify(data).slice(0, 300));
  }

  return {
    externalId:     data.invoice.invoice_id,
    externalNumber: data.invoice.invoice_number,
    externalUrl:    data.invoice.invoice_url || `https://books.zoho.com/app#/invoices/${data.invoice.invoice_id}`,
  };
}

// ── QuickBooks Online ─────────────────────────────────────────────────────────

async function findOrCreateQBCustomer(accessToken, realmId, invoiceData) {
  const custName = invoiceData.customer_name || 'Customer';
  const baseUrl  = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers  = {
    Authorization: `Bearer ${accessToken}`,
    Accept:        'application/json',
    'Content-Type': 'application/json',
  };

  // Query for existing customer
  const query    = `SELECT * FROM Customer WHERE DisplayName = '${custName.replace("'", "''")}'`;
  const queryUrl = `${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const qResp    = await fetch(queryUrl, { headers });
  const qData    = await qResp.json();
  const existing = qData.QueryResponse?.Customer?.[0];
  if (existing) return existing.Id;

  // Create customer
  const cResp = await fetch(`${baseUrl}/customer?minorversion=65`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      DisplayName:         custName,
      PrimaryPhone:        invoiceData.customer_phone ? { FreeFormNumber: invoiceData.customer_phone } : undefined,
      PrimaryEmailAddr:    invoiceData.customer_email ? { Address: invoiceData.customer_email } : undefined,
      BillAddr:            invoiceData.address ? { Line1: invoiceData.address } : undefined,
    }),
  });
  const cData = await cResp.json();
  if (!cData.Customer?.Id) throw new Error('Failed to create QuickBooks customer: ' + JSON.stringify(cData));
  return cData.Customer.Id;
}

async function createQuickBooksInvoice(db, uid, invoiceData) {
  const tokens = await ensureFreshToken(db, uid, 'quickbooks');
  if (!tokens) throw new Error('QuickBooks not connected or token revoked');
  const { accessToken, realmId } = tokens;
  if (!realmId) throw new Error('QuickBooks realmId missing');

  const baseUrl    = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers    = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const customerId = await findOrCreateQBCustomer(accessToken, realmId, invoiceData);
  const amount     = parseFloat(invoiceData.amount) || 0;
  const description = invoiceData.professional_description || invoiceData.job_type || 'Service';

  // Use a generic Service item (fallback to inline detail if item not found)
  let lineItem = {
    Amount:           amount,
    DetailType:       'SalesItemLineDetail',
    Description:      description,
    SalesItemLineDetail: {
      CustomerRef: { value: customerId },
      Qty:         1,
      UnitPrice:   amount,
    },
  };

  // Try to find a "Services" or "Service" item
  try {
    const iResp = await fetch(
      `${baseUrl}/query?query=${encodeURIComponent("SELECT * FROM Item WHERE Name = 'Services' MAXRESULTS 1")}&minorversion=65`,
      { headers }
    );
    const iData = await iResp.json();
    const item  = iData.QueryResponse?.Item?.[0];
    if (item) lineItem.SalesItemLineDetail.ItemRef = { value: item.Id, name: item.Name };
  } catch (_) { /* use inline detail */ }

  const invoiceBody = {
    CustomerRef:  { value: customerId },
    Line:         [{ ...lineItem, Id: '1', LineNum: 1 }],
    CustomerMemo: { value: `Via Relay SMS Dispatch | ${invoiceData.customer_phone || ''}` },
  };

  const resp = await fetch(`${baseUrl}/invoice?minorversion=65`, {
    method: 'POST',
    headers,
    body: JSON.stringify(invoiceBody),
  });
  const data = await resp.json();
  if (!data.Invoice) throw new Error('QuickBooks invoice creation failed: ' + JSON.stringify(data));

  return {
    externalId:     data.Invoice.Id,
    externalNumber: data.Invoice.DocNumber,
    externalUrl:    `https://app.qbo.intuit.com/app/invoice?txnId=${data.Invoice.Id}`,
  };
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Sync an invoice to the user's connected accounting platform.
 * Never throws — errors are caught and written to the invoice doc.
 */
export async function syncInvoiceToAccounting(db, uid, invoiceId, invoiceData, profile) {
  let provider = profile?.accountingProvider || profile?.platform;

  // A contractor who connected their accounting software but never re-saved the
  // profile form could end up with no provider recorded at all, and every
  // invoice was then silently skipped while the portal showed a healthy
  // connection. If nothing is recorded, believe the tokens: whichever platform
  // actually has credentials on file is the one they connected.
  //
  // An explicit 'none' is a real choice and is still honoured.
  if (!provider) {
    for (const candidate of ['zoho', 'quickbooks']) {
      const snap = await db.collection('users').doc(uid)
        .collection('oauth_tokens').doc(candidate).get();
      if (snap.exists) {
        provider = candidate;
        console.log(`[accounting-sync] uid=${uid} had no provider recorded; using connected ${candidate}`);
        // Repair the profile so the portal and the next sync agree.
        try {
          await db.collection('users').doc(uid).update({ accountingProvider: candidate });
        } catch (_) { /* the sync matters more than the repair */ }
        break;
      }
    }
  }

  if (!provider || provider === 'none') {
    console.log(`[accounting-sync] uid=${uid} has no accounting provider — skipping sync`);
    return { synced: false, reason: 'no_provider' };
  }

  const invoiceRef = db.collection('users').doc(uid).collection('invoices').doc(invoiceId);

  try {
    let result;
    if (provider === 'zoho') {
      result = await createZohoInvoice(db, uid, invoiceData);
    } else if (provider === 'quickbooks') {
      result = await createQuickBooksInvoice(db, uid, invoiceData);
    } else {
      throw new Error(`Unknown accounting provider: ${provider}`);
    }

    await invoiceRef.update({
      accountingSync: {
        synced:         true,
        provider,
        externalId:     result.externalId,
        externalNumber: result.externalNumber,
        externalUrl:    result.externalUrl,
        syncedAt:       new Date(),
      },
    });

    console.log(`[accounting-sync] Synced invoice ${invoiceId} to ${provider}: ${result.externalNumber}`);
    return { synced: true, provider, ...result };

  } catch (err) {
    console.error(`[accounting-sync] Sync failed for invoice ${invoiceId}:`, err.message);
    try {
      await invoiceRef.update({
        accountingSync: {
          synced:    false,
          provider,
          error:     err.message,
          failedAt:  new Date(),
        },
      });
    } catch (_) { /* don't block on write failure */ }
    return { synced: false, provider, error: err.message };
  }
}

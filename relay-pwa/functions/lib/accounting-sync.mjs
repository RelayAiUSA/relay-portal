// relay-pwa/functions/lib/accounting-sync.mjs
// Syncs a Relay invoice to the tradesperson's Zoho Books or QuickBooks account.
//
// Entry point: syncInvoiceToAccounting(db, uid, invoiceId, invoiceData, profile)
// Never throws — errors are caught and written back to the invoice doc.

import { ensureFreshToken } from './token-helpers.mjs';

// ── Zoho Books ────────────────────────────────────────────────────────────────

async function getZohoOrgId(accessToken) {
  const resp = await fetch('https://books.zoho.com/api/v3/organizations', {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await resp.json();
  const org  = data.organizations?.[0];
  if (!org) throw new Error('No Zoho organization found');
  return org.organization_id;
}

async function findOrCreateZohoContact(accessToken, orgId, invoiceData) {
  const phone    = (invoiceData.customer_phone || '').replace(/\D/g, '');
  const custName = invoiceData.customer_name || 'Customer';

  // Try to find by phone first (custom field match is unreliable in free tier — search by name)
  const searchResp = await fetch(
    `https://books.zoho.com/api/v3/contacts?organization_id=${orgId}&contact_name=${encodeURIComponent(custName)}`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );
  const searchData = await searchResp.json();
  if (searchData.contacts?.length > 0) return searchData.contacts[0].contact_id;

  // Create contact
  const body = {
    contact_name: custName,
    contact_type: 'customer',
    billing_address: invoiceData.address ? { address: invoiceData.address } : undefined,
    contact_persons: [{ phone }].filter(p => p.phone),
    notes: invoiceData.customer_email ? `Email: ${invoiceData.customer_email}` : undefined,
  };
  const createResp = await fetch(
    `https://books.zoho.com/api/v3/contacts?organization_id=${orgId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  const createData = await createResp.json();
  if (!createData.contact?.contact_id) throw new Error('Failed to create Zoho contact: ' + JSON.stringify(createData));
  return createData.contact.contact_id;
}

async function createZohoInvoice(db, uid, invoiceData) {
  const tokens = await ensureFreshToken(db, uid, 'zoho');
  if (!tokens) throw new Error('Zoho not connected or token revoked');
  const { accessToken } = tokens;

  const orgId     = tokens.organizationId || await getZohoOrgId(accessToken);
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

  const resp = await fetch(
    `https://books.zoho.com/api/v3/invoices?organization_id=${orgId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(invoiceBody),
    }
  );
  const data = await resp.json();
  if (!data.invoice) throw new Error('Zoho invoice creation failed: ' + JSON.stringify(data));

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
  const provider = profile?.accountingProvider || profile?.platform;
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

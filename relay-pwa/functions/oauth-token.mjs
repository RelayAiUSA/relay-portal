// relay-pwa/functions/oauth-token.mjs
// Server-side OAuth token exchange for QuickBooks and Zoho Books.
// Client secrets live in Netlify environment variables — never in client code.
// Migrated from Lambda compatibility mode to the modern Netlify Functions runtime
// using @netlify/aws-lambda-compat — handler logic is unchanged.

import { withLambda } from "@netlify/aws-lambda-compat";

export default withLambda(async function(event) {
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

  const { platform, code, realmId } = body;

  if (!platform || !code) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing platform or code' }) };
  }

  try {
    let tokenData;

    if (platform === 'quickbooks') {
      const clientId     = 'AB1iFjPkATxEZB6AjRd4i8SEdSW9GMCH7FCPzYHb2jOzLRyOxr';
      const clientSecret = process.env.INTUIT_CLIENT_SECRET;
      const redirectUri  = 'https://portal-relay.com/oauth-callback.html';

      const credentials = Buffer.from(clientId + ':' + clientSecret).toString('base64');
      const params = new URLSearchParams({
        grant_type:   'authorization_code',
        code:         code,
        redirect_uri: redirectUri,
      });

      const resp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method:  'POST',
        headers: {
          'Authorization': 'Basic ' + credentials,
          'Content-Type':  'application/x-www-form-urlencoded',
          'Accept':        'application/json',
        },
        body: params.toString(),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('QuickBooks token error:', err);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'QuickBooks token exchange failed', detail: err }) };
      }

      const data = await resp.json();
      tokenData = {
        platform:     'quickbooks',
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        realmId:      realmId || '',
        expiresIn:    data.expires_in,
        tokenType:    data.token_type,
        connectedAt:  new Date().toISOString(),
      };

    } else if (platform === 'zoho') {
      const clientId     = '1000.HPTPX3D50HAMNOOBYEV4LWZJ045Z7L';
      const clientSecret = process.env.ZOHO_CLIENT_SECRET;
      const redirectUri  = 'https://portal-relay.com/oauth-callback.html';

      const params = new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        code:          code,
      });

      const resp = await fetch('https://accounts.zoho.com/oauth/v2/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('Zoho token error:', err);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Zoho token exchange failed', detail: err }) };
      }

      const data = await resp.json();
      tokenData = {
        platform:     'zoho',
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresIn:    data.expires_in,
        tokenType:    data.token_type,
        connectedAt:  new Date().toISOString(),
      };

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown platform: ' + platform }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, tokenData }) };

  } catch (err) {
    console.error('oauth-token function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', detail: err.message }) };
  }
});

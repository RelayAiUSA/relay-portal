// netlify/functions/send-welcome-sms.js
// Sends a welcome onboarding SMS via Twilio after a new user signs up.
// Add in Netlify > Site settings > Environment variables:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { phone, name, companyName } = body;
  if (!phone) return { statusCode: 400, body: 'Missing phone' };

  const digits = phone.replace(/[^0-9]/g, '');
  const e164   = digits.startsWith('1') ? '+' + digits : '+1' + digits;

  const SID  = process.env.TWILIO_ACCOUNT_SID;
  const AUTH = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_FROM_NUMBER || '+18447291376';

  if (!SID || !AUTH) {
    console.error('Twilio credentials missing');
    return { statusCode: 500, body: 'SMS not configured' };
  }

  const co = companyName || name || 'there';

  const message = [
    'Welcome to RelayAI, ' + co + '! Thank you for signing up — we are excited to have you on board.',
    '',
    'Here is how to dispatch a job by text:',
    '',
    'Text +1 (844) 729-1376 with:',
    '> Invoice or Quote',
    '> Customer name & phone number',
    '> Job address',
    '> Description of work done',
    '> Total amount',
    '',
    'RelayAI handles the rest:',
    '* Builds a professional invoice or quote instantly',
    '* Texts it to your customer before you leave the job site',
    '* Logs it to your accounting software automatically',
    '* Sends a 5-star review request after payment',
    '',
    'Save us as a contact so you are ready to go:',
    'https://portal-relay.com/relay.vcf',
    '',
    'Questions? Reply to this text anytime.',
    '- The RelayAI Team',
  ].join('\n');

  try {
    const url   = 'https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Messages.json';
    const creds = Buffer.from(SID + ':' + AUTH).toString('base64');
    const form  = 'To=' + encodeURIComponent(e164) +
                  '&From=' + encodeURIComponent(FROM) +
                  '&Body=' + encodeURIComponent(message);

    const res  = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + creds },
      body: form,
    });

    const data = await res.json();
    if (!res.ok) { console.error('Twilio error:', data); return { statusCode: 502, body: data.message }; }

    console.log('Welcome SMS sent to', e164, '| SID:', data.sid);
    return { statusCode: 200, body: JSON.stringify({ sid: data.sid }) };

  } catch (err) {
    console.error('send-welcome-sms error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

export function rfc2047(value) {
  if (/[\r\n]/.test(value)) throw new Error('Subject cannot contain line breaks.');
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function gmailRaw({ email, subject, body }) {
  if (/[\r\n]/.test(email)) throw new Error('Recipient email cannot contain line breaks.');
  const encodedBody = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return Buffer.from([
    `To: ${email}`,
    `Subject: ${rfc2047(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody
  ].join('\r\n')).toString('base64url');
}

export class ProviderError extends Error {
  constructor(provider, status, message, retryAfter) {
    super(`${provider} API HTTP ${status}: ${message}`);
    this.provider = provider;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function request(url, options, provider, signal) {
  const response = await fetch(url, {...options, signal});
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).error?.message ?? JSON.parse(text).error_description ?? text; } catch { /* keep response body */ }
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ProviderError(provider, response.status, message || response.statusText, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
  return response;
}

export async function sendMessage(provider, accessToken, message, { signal } = {}) {
  if (provider === 'gmail') {
    await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: gmailRaw(message) })
    }, provider, signal);
    return;
  }
  await request('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject: message.subject, body: { contentType: 'Text', content: message.body }, toRecipients: [{ emailAddress: { address: message.email } }] } })
  }, provider, signal);
}

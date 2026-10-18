import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import open from 'open';
import * as msal from '@azure/msal-node';
import { readCredential, readSecret, writeCredential, writeSecret } from './token-store.js';

const gmailScope = 'https://www.googleapis.com/auth/gmail.send';
const microsoftScopes = ['Mail.Send'];
const noGoogleClientSecret = '__maillaunch_no_google_client_secret__';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function listenForCode(provider) {
  const state = randomBytes(24).toString('hex');
  let finish;
  let fail;
  const code = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('OAuth state mismatch.'); fail(new Error('OAuth state mismatch.')); return; }
    const error = url.searchParams.get('error');
    if (error) { res.writeHead(400).end(`Sign-in failed: ${error}`); fail(new Error(`Sign-in failed: ${error}`)); return; }
    const value = url.searchParams.get('code');
    if (!value) { res.writeHead(400).end('No authorization code was returned.'); fail(new Error('No authorization code was returned.')); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('MailLaunch sign-in complete. You can close this tab.');
    finish(value);
  });
  const host = provider === 'gmail' ? '127.0.0.1' : 'localhost';
  server.listen(0, host);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  const redirectUri = `http://${host}:${address.port}`;
  const timeout = setTimeout(() => fail(new Error('Sign-in timed out after 5 minutes.')), 5 * 60_000);
  return { state, redirectUri, code, close: () => { clearTimeout(timeout); server.close(); } };
}

async function openLogin(url) {
  console.log(`Opening your browser for sign-in. If it does not open, visit:\n${url}`);
  try { await open(url); } catch { /* The printed URL remains usable without a browser launcher. */ }
}

async function postToken(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status}): ${result.error_description ?? result.error ?? 'unknown error'}`);
  return result;
}

async function googleClientSecret(tokens = {}) {
  const fromEnvironment = process.env.MAILLAUNCH_GOOGLE_CLIENT_SECRET;
  if (fromEnvironment) return fromEnvironment;
  const savedSecret = readCredential('gmail-client-secret');
  if (savedSecret && savedSecret !== noGoogleClientSecret) return savedSecret;
  if (tokens.client_secret) return tokens.client_secret;
  if (savedSecret === noGoogleClientSecret) return null;
  if (!process.stdin.isTTY) throw new Error('Google client secret is missing. Run this command in a terminal or set MAILLAUNCH_GOOGLE_CLIENT_SECRET.');

  return promptGoogleClientSecret();
}
function saveGoogleClientSecret(secret) {
  const value = secret || noGoogleClientSecret;
  if (readCredential('gmail-client-secret') !== value) writeCredential('gmail-client-secret', value);
}
function promptGoogleClientSecret() {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw;
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
    };
    const onData = (chunk) => {
      const characters = chunk.toString('utf8').replace(/\x1b\[200~|\x1b\[201~/g, '');
      for (const character of characters) {
        if (character === '\u0003') {
          cleanup();
          output.write('\n');
          reject(new Error('Google client secret entry canceled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          output.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ' && character !== '\u007f' && character !== '\u001b') {
          value += character;
        }
      }
    };

    output.write('Google OAuth client secret (input hidden; press Enter if not required): ');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

export async function authGmail(config) {
  const clientId = config.gmail?.client_id;
  if (!clientId) throw new Error('Set gmail.client_id in maillaunch.config.yaml first.');
  const tokens = readSecret(config.state_dir, 'gmail-token') ?? {};
  const clientSecret = await googleClientSecret(tokens);
  const flow = await listenForCode('gmail');
  try {
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: flow.redirectUri, response_type: 'code', scope: gmailScope, access_type: 'offline', prompt: 'consent', state: flow.state, code_challenge: challenge, code_challenge_method: 'S256' });
    await openLogin(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
    const authorizationCode = await flow.code;
    const result = await postToken({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), code: authorizationCode, redirect_uri: flow.redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
    if (!result.refresh_token) throw new Error('Google returned no refresh token. Revoke MailLaunch access for this account and run auth again.');
    saveGoogleClientSecret(clientSecret);
    writeSecret(config.state_dir, 'gmail-token', { refresh_token: result.refresh_token });
    console.log('Gmail authorization saved to encrypted local storage.');
  } finally { flow.close(); }
}

function microsoftClient(config) {
  const credentials = { auth: { clientId: config.microsoft?.client_id, authority: config.microsoft?.authority ?? 'https://login.microsoftonline.com/common' } };
  if (!credentials.auth.clientId) throw new Error('Set microsoft.client_id in maillaunch.config.yaml first.');
  const tokenCache = {
    beforeCacheAccess: async (context) => { const serialized = readSecret(config.state_dir, 'microsoft-cache'); if (serialized) context.tokenCache.deserialize(serialized); },
    afterCacheAccess: async (context) => { if (context.cacheHasChanged) writeSecret(config.state_dir, 'microsoft-cache', context.tokenCache.serialize()); }
  };
  credentials.cache = { cachePlugin: tokenCache };
  return new msal.PublicClientApplication(credentials);
}

export async function authMicrosoft(config) {
  const client = microsoftClient(config);
  const flow = await listenForCode('microsoft');
  try {
    const { verifier, challenge } = pkce();
    const url = await client.getAuthCodeUrl({ scopes: microsoftScopes, redirectUri: flow.redirectUri, state: flow.state, codeChallenge: challenge, codeChallengeMethod: 'S256' });
    await openLogin(url);
    await client.acquireTokenByCode({ code: await flow.code, scopes: microsoftScopes, redirectUri: flow.redirectUri, codeVerifier: verifier });
    console.log('Microsoft authorization saved to encrypted local storage.');
  } finally { flow.close(); }
}

export async function googleAccessToken(config) {
  const tokens = readSecret(config.state_dir, 'gmail-token');
  if (!tokens?.refresh_token) throw new Error('Gmail is not authorized. Run: maillaunch auth gmail');
  const clientId = config.gmail?.client_id;
  if (!clientId) throw new Error('Set gmail.client_id in maillaunch.config.yaml first.');
  const clientSecret = await googleClientSecret(tokens);
  const result = await postToken({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), refresh_token: tokens.refresh_token, grant_type: 'refresh_token' });
  saveGoogleClientSecret(clientSecret);
  if (tokens.client_secret) writeSecret(config.state_dir, 'gmail-token', { refresh_token: tokens.refresh_token });
  return result.access_token;
}

export async function microsoftAccessToken(config, forceRefresh = false) {
  const client = microsoftClient(config);
  const account = (await client.getTokenCache().getAllAccounts())[0];
  if (!account) throw new Error('Microsoft is not authorized. Run: maillaunch auth microsoft');
  try {
    const result = await client.acquireTokenSilent({ account, scopes: microsoftScopes, forceRefresh });
    return result.accessToken;
  } catch (error) {
    throw new Error(`Microsoft token refresh failed. Run: maillaunch auth microsoft (${error.message})`);
  }
}

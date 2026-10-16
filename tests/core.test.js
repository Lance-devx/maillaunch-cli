import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseRecipients } from '../src/csv.js';
import { renderTemplate } from '../src/template.js';
import { openDb, createCampaign } from '../src/db.js';
import { runCampaign } from '../src/campaign.js';
import { gmailRaw } from '../src/providers.js';

test('CSV parsing handles BOM, quoted commas, and empty rows', () => {
  const rows = parseRecipients('\uFEFFemail,name,company\r\njane@example.com,"Jane, Jr.",Acme\r\n\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'jane@example.com');
  assert.equal(rows[0].data.name, 'Jane, Jr.');
});

test('email column detection accepts mail-containing header names', () => {
  const rows = parseRecipients('work_mail,first_name\nada@example.com,Ada');
  assert.equal(rows[0].email, 'ada@example.com');
});

test('template rendering replaces values, empties missing keys, and leaves nested braces alone', () => {
  assert.equal(renderTemplate('Hi {{name}} {{missing}} {{{nested}}}', { name: 'Ada' }), 'Hi Ada  {{{nested}}}');
});

test('Gmail MIME uses RFC 2047 subject encoding and base64url', () => {
  const raw = gmailRaw({ email: 'ada@example.com', subject: 'Olá, Ada', body: 'Hello' });
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
});

function fixture(t, recipients, retryAttempts = 0) {
  const stateDir = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.tmp-'));
  const db = openDb(stateDir);
  t.after(() => { db.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const campaign = {
    id: `c_${Date.now()}`, provider: 'gmail', createdAt: new Date().toISOString(),
    settings: { dailyLimit: 100, minDelay: 0, maxDelay: 0, retryAttempts },
    recipients: recipients.map((email, index) => ({ email, name: `Person ${index}`, data: { name: `Person ${index}` }, subject: 'Hi', body: 'Hello' }))
  };
  createCampaign(db, campaign);
  campaign.status = 'paused';
  const config = { state_dir: stateDir };
  return { db, campaign, config };
}

test('daily limit pauses a campaign before exceeding the limit', async (t) => {
  const { db, campaign, config } = fixture(t, ['one@example.com', 'two@example.com']);
  campaign.settings.dailyLimit = 1;
  let sends = 0;
  const result = await runCampaign(db, campaign, config, { getToken: async () => 'token', send: async () => { sends += 1; }, wait: async () => {} });
  assert.equal(result, 'paused');
  assert.equal(sends, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM recipients WHERE status = 'sent'").get().count, 1);
});

test('failed send retries with exponential backoff before succeeding', async (t) => {
  const { db, campaign, config } = fixture(t, ['retry@example.com'], 2);
  let sends = 0;
  const waits = [];
  const result = await runCampaign(db, campaign, config, {
    getToken: async () => 'token',
    send: async () => { if (++sends === 1) throw new Error('temporary failure'); },
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  assert.equal(result, 'complete');
  assert.equal(sends, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(db.prepare("SELECT status FROM recipients LIMIT 1").get().status, 'sent');
});

test('401 refreshes the token before resending', async (t) => {
  const { db, campaign, config } = fixture(t, ['refresh@example.com']);
  let sends = 0;
  const refreshes = [];
  const result = await runCampaign(db, campaign, config, {
    getToken: async (_provider, _config, forceRefresh) => { refreshes.push(Boolean(forceRefresh)); return forceRefresh ? 'new-token' : 'old-token'; },
    send: async (_provider, token) => { sends += 1; if (token === 'old-token') throw Object.assign(new Error('unauthorized'), { status: 401 }); },
    wait: async () => { throw new Error('should not wait'); }
  });
  assert.equal(result, 'complete');
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(sends, 2);
});

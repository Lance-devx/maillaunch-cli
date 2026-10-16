#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { openDb, createCampaign } from './db.js';
import { parseRecipients } from './csv.js';
import { renderTemplate } from './template.js';
import { authGmail, authMicrosoft } from './auth.js';
import { runCampaign, getDueScheduled, getResumable, latestCampaign, todayCount } from './campaign.js';
import { readTodayLog } from './log.js';

const program = new Command();
program.name('maillaunch').description('Send local email campaigns through Gmail or Microsoft Graph').option('-c, --config <file>', 'configuration file', 'maillaunch.config.yaml');

function config() { return loadConfig(program.optsWithGlobals().config); }
function providerName(value) {
  if (!['gmail', 'microsoft'].includes(value)) throw new Error('provider must be gmail or microsoft.');
  return value;
}
function campaignId() {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `c_${ymd}_${Math.random().toString(36).slice(2, 8)}`;
}
function scheduledTime(value) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('--schedule-at must be an ISO 8601 date-time with a timezone, such as 2026-10-16T18:00:00+08:00.');
  const time = new Date(value);
  if (!Number.isFinite(time.getTime()) || time <= new Date()) throw new Error('--schedule-at must be a valid future date-time.');
  return time.toISOString();
}
function dbFor(settings) { return openDb(settings.state_dir); }
async function runWithInterrupt(db, campaign, settings) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try { return await runCampaign(db, campaign, settings, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', onInterrupt); }
}
function commandResult(result) {
  console.log(typeof result === 'string' && result.startsWith('Authentication') ? result : `Campaign ${result}.`);
  if (typeof result === 'string' && result.startsWith('Authentication')) process.exitCode = 1;
}

const auth = program.command('auth').description('Authorize a sending account');
auth.command('gmail').description('Authorize Gmail').action(async () => authGmail(config()));
auth.command('microsoft').description('Authorize Microsoft 365').action(async () => authMicrosoft(config()));

program.command('send').description('Start a send campaign')
  .requiredOption('--csv <file>', 'recipient CSV file')
  .requiredOption('--subject <template>', 'subject template')
  .requiredOption('--body-file <file>', 'plain-text body template')
  .option('--provider <provider>', 'gmail or microsoft')
  .option('--min-delay <seconds>', 'minimum delay between sends', Number)
  .option('--max-delay <seconds>', 'maximum delay between sends', Number)
  .option('--schedule-at <datetime>', 'schedule campaign start time (ISO 8601 with timezone)')
  .action(async (options) => {
    const settings = config();
    const provider = providerName(options.provider ?? settings.provider);
    const minDelay = options.minDelay ?? settings.send.min_delay_seconds;
    const maxDelay = options.maxDelay ?? settings.send.max_delay_seconds;
    const scheduleAt = options.scheduleAt ? scheduledTime(options.scheduleAt) : null;
    if (!Number.isInteger(minDelay) || !Number.isInteger(maxDelay) || minDelay < 0 || maxDelay < minDelay) throw new Error('Delay values must be nonnegative integers, with max-delay >= min-delay.');
    const db = dbFor(settings);
    try {
      if (getResumable(db)) throw new Error('A resumable campaign exists. Run maillaunch resume before starting another.');
      const recipients = parseRecipients(fs.readFileSync(options.csv, 'utf8'));
      const body = fs.readFileSync(options.bodyFile, 'utf8');
      const campaign = {
        id: campaignId(), provider, createdAt: new Date().toISOString(),
        settings: { dailyLimit: settings.daily_limit, minDelay, maxDelay, retryAttempts: settings.send.retry_failed ? settings.send.retry_attempts : 0, scheduleAt },
        recipients: recipients.map((recipient) => ({ ...recipient, subject: renderTemplate(options.subject, recipient.data), body: renderTemplate(body, recipient.data) }))
      };
      createCampaign(db, campaign);
      if (scheduleAt) {
        console.log(`Campaign scheduled for ${scheduleAt}.`);
        console.log(`Campaign ID: ${campaign.id}`);
        return;
      }
      commandResult(await runWithInterrupt(db, campaign, settings));
      console.log(`Campaign ID: ${campaign.id}`);
    } finally { db.close(); }
  });

program.command('status').description("Show today's send count and latest queue status").action(() => {
  const settings = config();
  const db = dbFor(settings);
  try {
    console.log(`Today: ${todayCount(db)} / ${settings.daily_limit}`);
    const campaign = latestCampaign(db);
    if (!campaign) console.log('No campaigns yet.');
    else console.log(`${campaign.id} — ${campaign.status}${campaign.settings.scheduleAt ? ` for ${campaign.settings.scheduleAt}` : ''}; ${Object.entries(campaign.counts).map(([status, count]) => `${status}: ${count}`).join(', ') || 'empty queue'}`);
  } finally { db.close(); }
});

program.command('resume').description('Resume the most recent interrupted campaign').action(async () => {
  const settings = config();
  const db = dbFor(settings);
  try {
    const campaign = getResumable(db);
    if (!campaign) throw new Error('No interrupted campaign to resume.');
    commandResult(await runWithInterrupt(db, campaign, settings));
    console.log(`Campaign ID: ${campaign.id}`);
  } finally { db.close(); }
});

program.command('run-scheduled').description('Run scheduled campaigns whose start time has arrived').action(async () => {
  const settings = config();
  let db;
  try { db = dbFor(settings); }
  catch (error) {
    if (error.message === 'Another MailLaunch process is using the local state directory.') { console.log('MailLaunch is already running; skipping this scheduler tick.'); return; }
    throw error;
  }
  try {
    const campaigns = getDueScheduled(db);
    if (!campaigns.length) { console.log('No scheduled campaigns are due.'); return; }
    for (const campaign of campaigns) {
      console.log(`Starting scheduled campaign ${campaign.id}.`);
      const result = await runWithInterrupt(db, campaign, settings);
      commandResult(result);
      if (result === 'paused') break;
    }
  } finally { db.close(); }
});

program.command('log').description("Print today's send log").action(() => {
  const settings = config();
  const lines = readTodayLog(settings.state_dir);
  if (lines) process.stdout.write(lines);
  else console.log('No log entries for today.');
});

program.parseAsync().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

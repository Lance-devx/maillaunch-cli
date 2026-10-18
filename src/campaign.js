import { setTimeout as delay } from 'node:timers/promises';
import { findResumable, sentToday } from './db.js';
import { writeLog } from './log.js';
import { sendMessage } from './providers.js';
import { googleAccessToken, microsoftAccessToken } from './auth.js';

const tokenFor = (provider, config, forceRefresh = false) => provider === 'gmail' ? googleAccessToken(config) : microsoftAccessToken(config, forceRefresh);

export async function runCampaign(db, campaign, config, { send = (provider, token, message, options) => sendMessage(provider, token, message, options), getToken = tokenFor, wait = delay, signal } = {}) {
  const stateDir = config.state_dir;
  db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);
  const interrupted = db.prepare("SELECT * FROM recipients WHERE campaign_id = ? AND status = 'sending'").all(campaign.id);
  for (const recipient of interrupted) {
    const error = 'Send outcome is unknown after interruption; verify with the provider before manually retrying.';
    db.prepare("UPDATE recipients SET status = 'failed', error = ? WHERE id = ?").run(error, recipient.id);
    writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error });
  }

  const seenEmails = new Set();
  for (const recipient of db.prepare('SELECT * FROM recipients WHERE campaign_id = ? ORDER BY row_index').all(campaign.id)) {
    const email = recipient.email.trim().toLowerCase();
    if (seenEmails.has(email) && recipient.status === 'queued') {
      const reason = 'Duplicate recipient address in this campaign.';
      db.prepare("UPDATE recipients SET status = 'skipped', error = ? WHERE id = ?").run(reason, recipient.id);
      writeLog(stateDir, { status: 'SKIPPED', email: recipient.email, name: recipient.name, campaignId: campaign.id, reason });
    }
    seenEmails.add(email);
  }

  let accessToken;
  const queued = () => db.prepare("SELECT * FROM recipients WHERE campaign_id = ? AND status = 'queued' ORDER BY row_index").all(campaign.id);
  for (const recipient of queued()) {
    if (signal?.aborted) { db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id); return 'paused'; }
    if (sentToday(db) >= campaign.settings.dailyLimit) {
      writeLog(stateDir, { status: 'LIMIT_REACHED', email: recipient.email, name: recipient.name, campaignId: campaign.id });
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
      return 'paused';
    }

    const maxAttempts = campaign.settings.retryAttempts + 1;
    let sent = false;
    let attempt = 0;
    let finalError;
    while (attempt < maxAttempts && !sent) {
      if (signal?.aborted) { db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id); return 'paused'; }
      attempt += 1;
      db.prepare("UPDATE recipients SET status = 'sending', attempts = ?, error = NULL WHERE id = ?").run(attempt, recipient.id);
      try {
        accessToken ??= await getToken(campaign.provider, config);
        await send(campaign.provider, accessToken, { email: recipient.email, subject: recipient.subject, body: recipient.body }, { signal });
        sent = true;
      } catch (error) {
        if (error.name === 'AbortError' || signal?.aborted) {
          const message = 'Send interrupted; outcome is unknown. Verify with the provider before manually retrying.';
          db.prepare("UPDATE recipients SET status = 'failed', error = ? WHERE id = ?").run(message, recipient.id);
          writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: message });
          db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
          return 'paused';
        }
        if (error.status === 401) {
          try {
            accessToken = await getToken(campaign.provider, config, true);
          } catch (refreshError) {
            finalError = new Error(`Authentication expired. Run maillaunch auth ${campaign.provider} and resume the campaign. ${refreshError.message}`);
            db.prepare("UPDATE recipients SET status = 'queued', error = ? WHERE id = ?").run(finalError.message, recipient.id);
            writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: finalError.message });
            db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
            return finalError.message;
          }
          try {
            await send(campaign.provider, accessToken, { email: recipient.email, subject: recipient.subject, body: recipient.body }, { signal });
            sent = true;
          } catch (refreshedError) {
            if (refreshedError.name === 'AbortError' || signal?.aborted) {
              const message = 'Send interrupted; outcome is unknown. Verify with the provider before manually retrying.';
              db.prepare("UPDATE recipients SET status = 'failed', error = ? WHERE id = ?").run(message, recipient.id);
              writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: message });
              db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
              return 'paused';
            }
            if (refreshedError.status === 401) {
              finalError = new Error(`Authentication expired. Run maillaunch auth ${campaign.provider} and resume the campaign. ${refreshedError.message}`);
              db.prepare("UPDATE recipients SET status = 'queued', error = ? WHERE id = ?").run(finalError.message, recipient.id);
              writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: finalError.message });
              db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
              return finalError.message;
            }
            error = refreshedError;
          }
        }
        if (!sent && /not authorized|invalid_grant|oauth failed/i.test(error.message)) {
          finalError = new Error(`Authentication failed. Run maillaunch auth ${campaign.provider} and resume the campaign. ${error.message}`);
          db.prepare("UPDATE recipients SET status = 'queued', error = ? WHERE id = ?").run(finalError.message, recipient.id);
          writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: finalError.message });
          db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id);
          return finalError.message;
        }
        if (!sent) {
          finalError = error;
          if (attempt < maxAttempts) {
            const seconds = error.retryAfter ?? 2 ** attempt;
            writeLog(stateDir, { status: 'RETRY', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: error.message, attempt, maxAttempts: campaign.settings.retryAttempts, delaySeconds: seconds });
            try { await wait(seconds * 1000, undefined, { signal }); } catch (waitError) {
              if (waitError.name === 'AbortError') { db.prepare("UPDATE recipients SET status = 'queued' WHERE id = ?").run(recipient.id); db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id); return 'paused'; }
              throw waitError;
            }
          }
        }
      }
    }

    if (sent) {
      const sentAt = new Date().toISOString();
      db.prepare("UPDATE recipients SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(sentAt, recipient.id);
      writeLog(stateDir, { status: 'SENT', email: recipient.email, name: recipient.name, campaignId: campaign.id });
      const remaining = queued().some((row) => row.id !== recipient.id);
      if (remaining) {
        const min = campaign.settings.minDelay;
        const max = campaign.settings.maxDelay;
        const seconds = min + Math.floor(Math.random() * (max - min + 1));
        try { await wait(seconds * 1000, undefined, { signal }); } catch (error) {
          if (error.name === 'AbortError') { db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaign.id); return 'paused'; }
          throw error;
        }
      }
    } else {
      db.prepare("UPDATE recipients SET status = 'failed', error = ? WHERE id = ?").run(finalError?.message ?? 'Unknown send error', recipient.id);
      writeLog(stateDir, { status: 'FAILED', email: recipient.email, name: recipient.name, campaignId: campaign.id, error: finalError?.message ?? 'Unknown send error' });
    }
  }

  const failed = db.prepare("SELECT count(*) AS count FROM recipients WHERE campaign_id = ? AND status = 'failed'").get(campaign.id).count;
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(failed ? 'complete_with_failures' : 'complete', campaign.id);
  return failed ? 'complete_with_failures' : 'complete';
}

export function latestCampaign(db) {
  const row = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1').get();
  if (!row) return null;
  const counts = Object.fromEntries(db.prepare('SELECT status, count(*) AS count FROM recipients WHERE campaign_id = ? GROUP BY status').all(row.id).map((item) => [item.status, item.count]));
  return { ...row, settings: JSON.parse(row.settings_json), counts };
}

export function getResumable(db) {
  return findResumable(db);
}

export function getDueScheduled(db, now = new Date()) {
  return db.prepare("SELECT * FROM campaigns WHERE status = 'scheduled' ORDER BY created_at").all()
    .map((campaign) => ({ ...campaign, settings: JSON.parse(campaign.settings_json) }))
    .filter((campaign) => Date.parse(campaign.settings.scheduleAt) <= now.getTime());
}

export function todayCount(db) {
  return sentToday(db);
}

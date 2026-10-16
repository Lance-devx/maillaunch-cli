import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const defaults = { provider: 'gmail', daily_limit: 100, state_dir: path.join(os.homedir(), '.maillaunch'), send: { min_delay_seconds: 60, max_delay_seconds: 180, retry_failed: true, retry_attempts: 2 } };

export function loadConfig(file = 'maillaunch.config.yaml') {
  const values = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) ?? {} : {};
  if (typeof values !== 'object' || Array.isArray(values)) throw new Error('Configuration file must contain a YAML mapping.');
  const config = { ...defaults, ...values, send: { ...defaults.send, ...values.send } };
  if (!['gmail', 'microsoft'].includes(config.provider)) throw new Error('provider must be gmail or microsoft.');
  if (!Number.isInteger(config.daily_limit) || config.daily_limit < 1) throw new Error('daily_limit must be a positive integer.');
  if (!Number.isInteger(config.send.min_delay_seconds) || !Number.isInteger(config.send.max_delay_seconds) || config.send.min_delay_seconds < 0 || config.send.max_delay_seconds < config.send.min_delay_seconds) throw new Error('Send delays must be nonnegative integers, with max_delay_seconds >= min_delay_seconds.');
  if (!Number.isInteger(config.send.retry_attempts) || config.send.retry_attempts < 0) throw new Error('retry_attempts must be a nonnegative integer.');
  if (typeof config.send.retry_failed !== 'boolean') throw new Error('retry_failed must be true or false.');
  if (typeof config.state_dir !== 'string' || !config.state_dir.trim()) throw new Error('state_dir must be a nonempty path.');
  config.state_dir = config.state_dir.startsWith('~/') ? path.join(os.homedir(), config.state_dir.slice(2)) : path.resolve(config.state_dir);
  return config;
}

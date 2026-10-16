import fs from 'node:fs';
import path from 'node:path';

export function writeLog(stateDir, event) {
  const date = localDate();
  const logDir = path.join(stateDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(logDir, `${date}.jsonl`), `${line}\n`, { mode: 0o600 });
  return line;
}

export function readTodayLog(stateDir) {
  const date = localDate();
  const file = path.join(stateDir, 'logs', `${date}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

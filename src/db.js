import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
const SQL = await initSqlJs({ locateFile: () => wasmPath });

class LocalDatabase {
  constructor(file, lockFile) {
    this.file = file;
    this.lockFile = lockFile;
    this.lockContents = `${process.pid}\n`;
    this.database = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.inTransaction = false;
  }
  prepare(sql) {
    return {
      run: (...params) => { this.database.run(sql, params); const result = { changes: this.database.getRowsModified() }; if (!this.inTransaction) this.save(); return result; },
      get: (...params) => { const statement = this.database.prepare(sql); try { statement.bind(params); return statement.step() ? statement.getAsObject() : undefined; } finally { statement.free(); } },
      all: (...params) => { const statement = this.database.prepare(sql); const rows = []; try { statement.bind(params); while (statement.step()) rows.push(statement.getAsObject()); return rows; } finally { statement.free(); } }
    };
  }
  exec(sql) { this.database.exec(sql); this.save(); }
  transaction(callback) {
    return (...args) => {
      this.database.exec('BEGIN');
      this.inTransaction = true;
      let result;
      try { result = callback(...args); this.database.exec('COMMIT'); }
      catch (error) { this.database.exec('ROLLBACK'); this.inTransaction = false; throw error; }
      this.inTransaction = false;
      this.save();
      return result;
    };
  }
  save() {
    // shortcut: SQL.js rewrites the local SQLite file on state changes; switch to a native SQLite binding for very large histories.
    const temp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, Buffer.from(this.database.export())); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
  }
  close() {
    this.database.close();
    try { if (fs.readFileSync(this.lockFile, 'utf8') === this.lockContents) fs.unlinkSync(this.lockFile); } catch { /* another process may have already cleaned up a stale lock */ }
  }
}

export function openDb(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, 'state.lock');
  try { fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    let alive = Number.isSafeInteger(pid) && pid > 0;
    if (alive) try { process.kill(pid, 0); } catch (checkError) { alive = checkError.code !== 'ESRCH'; }
    if (alive) throw new Error('Another MailLaunch process is using the local state directory.');
    fs.rmSync(lockFile, { force: true });
    fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  }
  try {
    const db = new LocalDatabase(path.join(stateDir, 'state.sqlite'), lockFile);
    db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at TEXT NOT NULL,
    status TEXT NOT NULL, settings_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), row_index INTEGER NOT NULL,
    email TEXT NOT NULL, name TEXT NOT NULL, data_json TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, sent_at TEXT, error TEXT,
    UNIQUE(campaign_id, row_index)
  );`);
    return db;
  } catch (error) {
    fs.rmSync(lockFile, { force: true });
    throw error;
  }
}

export function createCampaign(db, campaign) {
  const save = db.transaction(() => {
    db.prepare('INSERT INTO campaigns (id, provider, created_at, status, settings_json) VALUES (?, ?, ?, ?, ?)')
      .run(campaign.id, campaign.provider, campaign.createdAt, 'paused', JSON.stringify(campaign.settings));
    const insert = db.prepare('INSERT INTO recipients (campaign_id, row_index, email, name, data_json, subject, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
    campaign.recipients.forEach((recipient, index) => insert.run(campaign.id, index, recipient.email, recipient.name, JSON.stringify(recipient.data), recipient.subject, recipient.body));
  });
  save();
}

export function findResumable(db) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE status IN ('paused', 'running') ORDER BY created_at DESC LIMIT 1").get();
  return campaign && { ...campaign, settings: JSON.parse(campaign.settings_json) };
}

export function localDayBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

export function sentToday(db, provider, now = new Date()) {
  const [start, end] = localDayBounds(now);
  return db.prepare('SELECT count(*) AS count FROM recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE c.provider = ? AND r.status = ? AND r.sent_at >= ? AND r.sent_at < ?').get(provider, 'sent', start, end).count;
}

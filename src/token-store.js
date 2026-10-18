import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';

const keyEntry = new Entry('maillaunch', 'token-encryption-key', { linux: { store: 'secret-service' } });
function credentialEntry(name) { return new Entry('maillaunch', name, { linux: { store: 'secret-service' } }); }

export function readCredential(name) { return credentialEntry(name).getPassword(); }
export function writeCredential(name, value) { credentialEntry(name).setPassword(value); }

function encryptionKey(create = true) {
  let value = keyEntry.getPassword();
  if (!value && create) {
    value = randomBytes(32).toString('base64');
    keyEntry.setPassword(value);
  }
  return value ? Buffer.from(value, 'base64') : null;
}

export function readSecret(stateDir, name) {
  const file = path.join(stateDir, `${name}.enc`);
  if (!fs.existsSync(file)) return null;
  const key = encryptionKey(false);
  if (!key) throw new Error('MailLaunch token encryption key is missing from the OS credential store. Remove stale token files and sign in again.');
  const contents = Buffer.from(fs.readFileSync(file, 'utf8'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, contents.subarray(0, 12));
  decipher.setAuthTag(contents.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(contents.subarray(28)), decipher.final()]).toString('utf8'));
}

export function writeSecret(stateDir, name, value) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  const file = path.join(stateDir, `${name}.enc`);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, encrypted.toString('base64'), { mode: 0o600 });
  fs.renameSync(temp, file);
}

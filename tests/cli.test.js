import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('CLI loads config passed after the command', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.cli-'));
  const config = path.join(dir, 'config.yaml');
  fs.writeFileSync(config, `state_dir: "${dir.replaceAll('\\', '/')}"\nprovider: gmail\ndaily_limit: 100\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['src/main.js', 'status', '--config', config], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Today: 0 \/ 100/);
});

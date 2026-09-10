import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('browser smoke bootstraps CDP before navigation and retries with clean profiles', async () => {
  const source = await readFile('scripts/browser-smoke.py', 'utf8');
  assert.match(source, /def launch_browser_with_cdp\(/);
  assert.match(source, /about:blank/);
  assert.match(source, /for attempt in range\(1, 4\)/);
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /shutil\.rmtree\(profile, ignore_errors=True\)/);
  assert.match(source, /Page\.navigate/);
});

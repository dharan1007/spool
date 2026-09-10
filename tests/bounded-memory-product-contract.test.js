import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function text(path) { return readFile(path, 'utf8'); }

test('public Local Runner contract states bounded-memory execution while preserving exact size boundaries', async () => {
  const [readme, localRunner, security, roadmap, surface] = await Promise.all([
    text('README.md'),
    text('docs/LOCAL_RUNNER.md'),
    text('SECURITY.md'),
    text('ROADMAP.md'),
    text('src/product-surface.js')
  ]);
  const combined = `${readme}\n${localRunner}\n${security}\n${roadmap}\n${surface}`;

  assert.match(readme, /Browser Studio[\s\S]{0,500}50 MiB/);
  assert.match(readme, /Local Runner[\s\S]{0,1500}256 MiB/i);
  assert.match(localRunner, /bounded-memory/i);
  assert.match(localRunner, /256 MiB/);
  assert.match(localRunner, /50 MiB/);
  assert.doesNotMatch(localRunner, /still materializes the source in memory/i);

  assert.match(combined, /durable snapshot/i);
  assert.match(combined, /disk space/i);
  assert.match(combined, /SOURCE_CHANGED/);
  assert.match(combined, /cleanup/i);
  assert.match(combined, /re-scan|rescan/i);
  assert.match(security, /bounded-memory/i);
  assert.match(surface, /bounded-memory/i);
  assert.match(surface, /256 MiB/);
  assert.match(surface, /50 MiB/);

  assert.match(roadmap, /Delivered[\s\S]*bounded-memory/i);
  assert.doesNotMatch(roadmap, /### Scale[\s\S]*Streaming local-runner ingestion so memory is bounded by batch size/i);
});

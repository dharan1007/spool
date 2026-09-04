import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const watchdog = await readFile(new URL('../boot-watchdog.js', import.meta.url), 'utf8');

test('root document is a minimal resilient app shell instead of a monolithic workbench', () => {
  assert.match(html, /id="app-root"/);
  assert.match(html, /src="\/boot-watchdog\.js"/);
  assert.match(html, /src="\/src\/app\.js"/);
  assert.match(html, /href="\/styles\.css"/);
  assert.doesNotMatch(html, /target-json|mapping-editor|runtime-panel|tool-inspector/);
  assert.match(html, /connect-src 'none'/);
});

test('product frontend defines separate explanatory and Studio routes', () => {
  for (const route of ['/', '/autopilot', '/how-it-works', '/webmcp', '/benchmarks', '/docs', '/studio', '/studio/new', '/studio/mission', '/studio/results']) {
    assert.match(app, new RegExp(route.replaceAll('/', '\\/')),
      `missing route ${route}`);
  }
  for (const phrase of ['Run Autopilot', 'Advanced diagnostics', 'How SPOOL works', 'Temporal WebMCP', 'No action required']) {
    assert.match(app, new RegExp(phrase), `missing UX copy: ${phrase}`);
  }
  assert.match(app, /run_autopilot/);
  assert.match(app, /inspect_mission/);
});

test('boot path renders a visible failure state instead of leaving Loading SPOOL forever', () => {
  assert.match(watchdog, /Startup timed out/);
  assert.match(watchdog, /__spoolMarkBooted/);
  assert.match(app, /__spoolMarkBooted/);
  assert.match(app, /renderBootFailure/);
  assert.match(app, /Unable to start SPOOL/);
  assert.match(app, /try\s*\{/);
  assert.match(app, /catch\s*\(/);
});

test('visual system covers public storytelling, Studio workflow, diagnostics and responsive navigation', async () => {
  const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['.hero-grid', '.step-flow', '.studio-rail', '.setup-layout', '.outcome-option', '.mission-grid', '.evidence-table', '.advanced', '.result-hero', '.boot-failure']) {
    assert.match(styles, new RegExp(selector.replace('.', '\\.')), `missing style ${selector}`);
  }
  assert.match(styles, /@media\s*\(max-width:\s*900px\)/);
  assert.match(styles, /:focus-visible/);
});

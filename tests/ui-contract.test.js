import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, site, content, studio, styles, watchdog] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-redesign.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-content.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/studio-flow.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-redesign.css', import.meta.url), 'utf8'),
  readFile(new URL('../boot-watchdog.js', import.meta.url), 'utf8')
]);

test('root document loads one public renderer and one Studio renderer', () => {
  assert.match(html, /id="app-root"/);
  assert.match(html, /src="\/boot-watchdog\.js"/);
  assert.match(html, /src="\/src\/app\.js"/);
  assert.match(html, /src="\/src\/studio-flow\.js"/);
  assert.match(html, /src="\/src\/site-redesign\.js"/);
  assert.match(html, /href="\/src\/site-redesign\.css"/);
  assert.doesNotMatch(html, /src="\/src\/product-surface\.js"/);
  assert.match(html, /connect-src 'none'/);
});

test('public site is action-driven and exposes all supported surfaces', () => {
  for (const route of ['/', '/how-it-works', '/webmcp', '/benchmarks', '/docs', '/local-runner', '/examples', '/security', '/services']) {
    assert.ok(content.includes("'" + route + "'"), 'missing public route ' + route);
  }
  for (const phrase of [
    'Seven pages. Seven jobs.',
    'Start with a file',
    'Prepare a dataset',
    'Write to SQLite',
    'No mystery button',
    'No dead ends',
    'Browser Studio',
    'Local Runner'
  ]) assert.match(content, new RegExp(phrase, 'i'), 'missing clear UX copy: ' + phrase);
  assert.doesNotMatch(content, /Run Autopilot/i);
});

test('legacy Autopilot route redirects into the explicit Studio flow', () => {
  assert.match(app, /path === '\/autopilot'/);
  assert.match(app, /replaceState\(\{\}, '', '\/studio\/original'\)/);
  assert.match(app, /REDESIGNED_SITE_PATHS/);
  assert.match(app, /data-spool-site-root/);
  assert.match(site, /data-site-route/);
  assert.match(site, /spool:site-route/);
  assert.match(site, /spool:statechange/);
});

test('complete product truth remains visible without a competing renderer', () => {
  for (const phrase of [
    'source snapshot',
    'target contract',
    'target_write',
    'fencing',
    'reconciliation',
    'verification',
    'receipt',
    'spoold',
    'PostgreSQL',
    'MySQL',
    '5 source records',
    '3 valid',
    '2 rejected',
    'DEPLOYMENT',
    'Production target writes stay local'
  ]) assert.match(content, new RegExp(phrase, 'i'), 'missing product truth: ' + phrase);
  assert.doesNotMatch(content, /paid checkout/i);
});

test('boot path renders a visible failure state', () => {
  assert.match(watchdog, /Startup timed out/);
  assert.match(watchdog, /__spoolMarkBooted/);
  assert.match(app, /__spoolMarkBooted/);
  assert.match(app, /renderBootFailure/);
  assert.match(app, /Unable to start SPOOL/);
});

test('visual system covers the public site, responsive navigation and Studio action states', () => {
  for (const selector of [
    '.redesign-topbar',
    '.redesign-decision',
    '.redesign-workflow',
    '.redesign-stage-list',
    '.redesign-choice-grid',
    '.redesign-proof-grid',
    '.flow-page-actions',
    '.flow-dropzone.locked',
    '.flow-action-lock'
  ]) assert.ok(styles.includes(selector), 'missing redesigned style ' + selector);
  assert.match(styles, /@media\(max-width:760px\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(studio, /reset-terminal/);
});

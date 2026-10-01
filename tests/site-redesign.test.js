import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, app, site, pages, studio, css, product] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-redesign.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-content.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/studio-flow.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/site-redesign.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/product-surface.js', import.meta.url), 'utf8')
]);

test('public redesign loads after core app and Studio without a competing product observer', () => {
  assert.ok(html.indexOf('/src/app.js') < html.indexOf('/src/studio-flow.js'));
  assert.ok(html.indexOf('/src/studio-flow.js') < html.indexOf('/src/site-redesign.js'));
  assert.doesNotMatch(product, /MutationObserver/);
  assert.match(product, /PRODUCT_SURFACE_DEPRECATED/);
  assert.match(app, /REDESIGNED_SITE_PATHS/);
  assert.match(site, /data-spool-site-root/);
});

test('homepage presents two explicit paths and the seven-stage workflow', () => {
  for (const phrase of [
    'CHOOSE WHAT YOU NEED',
    'Prepare a dataset',
    'Write to SQLite',
    'Original file',
    'Inspect',
    'Understand',
    'Transform',
    'Dry-run without changes',
    'Process',
    'Validate'
  ]) assert.match(pages, new RegExp(phrase, 'i'), 'missing homepage workflow content: ' + phrase);
});

test('Studio terminal, active-run and blocked states always expose recovery actions', () => {
  assert.match(studio, /Source replacement is locked while processing/);
  assert.match(studio, /Open current processing/);
  assert.match(studio, /reset-terminal/);
  assert.match(studio, /Start a new migration/);
  assert.match(studio, /Replace source file/);
  assert.match(studio, /Review problem columns/);
  assert.match(studio, /flow-action-lock/);
  assert.match(studio, /busyAction/);
  assert.match(studio, /Finish or abort the active processing run/);
});

test('visual redesign is responsive and keeps action bars visible', () => {
  assert.match(css, /\.redesign-topbar/);
  assert.match(css, /\.redesign-workflow/);
  assert.match(css, /\.redesign-choice/);
  assert.match(css, /\.flow-page-actions\{position:sticky/);
  assert.match(css, /\.flow-dropzone\.locked/);
  assert.match(css, /@media\(max-width:760px\)/);
});

test('Autopilot is not a public navigation action', () => {
  assert.doesNotMatch(pages, /Run Autopilot/i);
  assert.match(app, /path === '\/autopilot'/);
  assert.match(app, /\/studio\/original/);
});

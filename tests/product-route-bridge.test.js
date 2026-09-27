import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const productSource = readFileSync(new URL('../src/product-surface.js', import.meta.url), 'utf8');
const PRODUCT_PATHS = ['/local-runner', '/examples', '/security', '/services', '/start', '/integrations', '/developers'];

function productBridge() {
  const window = { location: { pathname: '/start' }, addEventListener() {} };
  const document = { getElementById() { return null; } };
  return new Function('window', 'document', 'MutationObserver', 'queueMicrotask',
    productSource + '\nreturn window.__spoolProductSurface;'
  )(window, document, class {}, () => {});
}

function appFunction(name, nextName, extra) {
  const begin = appSource.indexOf('function ' + name + '(');
  let end = appSource.indexOf('\nfunction ' + nextName + '(', begin);
  if (end < 0) end = appSource.indexOf('\nasync function ' + nextName + '(', begin);
  assert.ok(begin >= 0 && end > begin, name + ' must have a bounded definition');
  return new Function(...extra.names, appSource.slice(begin, end) + '\nreturn ' + name + ';')(...extra.values);
}

test('every supported product page renders actual human-facing HTML without undefined placeholders', () => {
  const bridge = productBridge();
  for (const path of PRODUCT_PATHS) {
    const html = bridge.render(path);
    assert.ok(html.includes('data-product-route="' + path + '"'), path);
    assert.ok(html.includes('<main'), path);
    assert.ok(!html.includes('undefined'), path);
    assert.ok(!html.includes('That SPOOL route does not exist'), path);
    assert.notEqual(bridge.title(path), 'SPOOL');
  }
  assert.equal(bridge.render('/not-a-route'), null);
});

test('SPA renders all product pages directly rather than a transient 404', () => {
  const bridge = productBridge();
  for (const path of PRODUCT_PATHS) {
    const root = { innerHTML: '' };
    const document = { title: '' };
    const render = appFunction('render', 'pageTitle', {
      names: ['appRoot', 'latestState', 'currentPath', 'window', 'document'],
      values: [root, {}, () => path, { __spoolProductSurface: bridge }, document]
    });
    render();
    assert.equal(root.innerHTML, bridge.render(path), path);
    assert.equal(document.title, bridge.title(path) + ' — SPOOL', path);
  }
});

test('valid product URLs show loading state, never 404, if sibling bundle has not evaluated', () => {
  const root = { innerHTML: '' };
  const render = appFunction('render', 'pageTitle', {
    names: ['appRoot', 'latestState', 'currentPath', 'window', 'document'],
    values: [root, {}, () => '/start', {}, { title: '' }]
  });
  render();
  assert.match(root.innerHTML, /Loading SPOOL/);
  assert.doesNotMatch(root.innerHTML, /404/);
});

test('navigation accepts product URLs and rejects unknown routes', () => {
  const routeDefinition = appSource.match(/const ROUTES = Object\.freeze\((\[[\s\S]*?\])\);/);
  assert.ok(routeDefinition);
  const routes = new Function('return ' + routeDefinition[1])();
  for (const path of PRODUCT_PATHS) assert.ok(routes.includes(path), path);
  const moved = [];
  const window = {
    location: { pathname: '/' },
    history: { pushState(_, __, path) { moved.push(path); } },
    scrollTo() {}
  };
  const navigate = appFunction('navigate', 'scheduleRender', {
    names: ['ROUTES', 'window', 'render'],
    values: [routes, window, () => {}]
  });
  navigate('/local-runner');
  navigate('/start');
  navigate('/not-a-route');
  assert.deepEqual(moved, ['/local-runner', '/start']);
});

test('product-to-Studio clicks stay in SPA; modified, external, or download clicks stay native', () => {
  let handler;
  const routes = ['/', '/studio/new', '/start', '/local-runner'];
  const moved = [];
  const root = { addEventListener(type, listener) { if (type === 'click') handler = listener; } };
  const window = { addEventListener() {} };
  const bind = appFunction('bindGlobalEvents', 'initWebMcp', {
    names: ['appRoot', 'window', 'ROUTES', 'navigate', 'render'],
    values: [root, window, routes, route => moved.push(route), () => {}]
  });
  bind();
  assert.equal(typeof handler, 'function');
  function click(href, options = {}) {
    let prevented = false;
    const anchor = {
      dataset: {},
      getAttribute(name) { return name === 'href' ? href : null; },
      hasAttribute(name) { return name === 'download' ? Boolean(options.download) : false; }
    };
    handler({
      target: { closest(selector) { return selector === '[data-route], a[href^="/"]' ? anchor : null; } },
      defaultPrevented: false,
      button: 0,
      ...options,
      preventDefault() { prevented = true; }
    });
    return prevented;
  }
  assert.equal(click('/studio/new'), true);
  assert.equal(click('/start'), true);
  assert.equal(click('/start', { ctrlKey: true }), false);
  assert.equal(click('/start', { metaKey: true }), false);
  assert.equal(click('/start', { button: 1 }), false);
  assert.equal(click('/start', { download: true }), false);
  assert.equal(click('https://example.com/'), false);
  assert.deepEqual(moved, ['/studio/new', '/start']);
});

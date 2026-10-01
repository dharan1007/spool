import { renderSitePage, SITE_PATHS } from './site-content.js';

const PATHS = new Set(SITE_PATHS);
let queued = false;
let rendering = false;

function rawPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

function api() {
  return window.__spoolTest || null;
}

function state() {
  var app = api();
  if (!app) return null;
  return app.viewState ? app.viewState() : app.state();
}

function resumePath(current) {
  if (!current || !current.source) return '/studio/original';
  var phase = current.job && current.job.phase;
  if (phase === 'COMPLETE') return '/studio/validate';
  if (['RUNNING', 'REPLAYING', 'PAUSED', 'PAUSED_RECOVERED'].includes(phase)) return '/studio/process';
  if (phase === 'MAPPING_VALID') return '/studio/test';
  return '/studio/inspect';
}

function phaseTone(phase) {
  if (phase === 'COMPLETE') return 'success';
  if (phase === 'FAILED' || phase === 'ABORTED') return 'danger';
  if (phase === 'RUNNING' || phase === 'REPLAYING') return 'running';
  if (phase === 'PAUSED' || phase === 'PAUSED_RECOVERED') return 'warning';
  return 'neutral';
}

function route(href, label, cls) {
  return "<a href='" + href + "' data-site-route='" + href + "' class='" + (cls || '') + "'>" + label + "</a>";
}

function topbar(path, current) {
  var resume = resumePath(current);
  var phase = current && current.job ? current.job.phase : 'EMPTY';
  var nav = [
    ['/how-it-works', 'How it works'],
    ['/local-runner', 'Local Runner'],
    ['/security', 'Security'],
    ['/docs', 'Docs']
  ];
  return [
    "<header class='redesign-topbar'>",
      "<a class='redesign-brand' href='/' data-site-route='/' aria-label='SPOOL home'><span>S</span><div><strong>SPOOL</strong><small>Migration correctness</small></div></a>",
      "<nav class='redesign-nav' aria-label='Primary navigation'>",
        nav.map(function (item) { return route(item[0], item[1], path === item[0] ? 'active' : ''); }).join(''),
      "</nav>",
      "<div class='redesign-top-actions'>",
        current && current.source ? "<span class='redesign-phase " + phaseTone(phase) + "'><i></i>" + phase + "</span>" : "",
        route(resume, current && current.source ? 'Resume Studio' : 'Start Studio', 'redesign-button primary compact'),
      "</div>",
    "</header>"
  ].join('');
}

function footer() {
  return [
    "<footer class='redesign-footer'>",
      "<div><strong>SPOOL</strong><span>Explicit stages. Deterministic transforms. Verifiable output.</span></div>",
      "<nav>", route('/examples', 'Examples'), route('/services', 'Deployment'), route('/webmcp', 'WebMCP'), route('/benchmarks', 'Verification'), "</nav>",
    "</footer>"
  ].join('');
}

function pageTitle(path) {
  return ({
    '/': 'Migration workflow',
    '/how-it-works': 'How it works',
    '/webmcp': 'WebMCP',
    '/benchmarks': 'Verification',
    '/docs': 'Docs',
    '/local-runner': 'Local Runner',
    '/examples': 'Examples',
    '/security': 'Security',
    '/services': 'Deployment & support'
  })[path] || 'SPOOL';
}

function renderSite() {
  var path = rawPath();
  if (rendering || !PATHS.has(path)) return;
  var root = document.getElementById('app-root');
  var app = api();
  if (!root || !app) return;
  var current = state();
  if (!current) return;
  var context = {
    hasSource: Boolean(current.source),
    resumePath: resumePath(current),
    phase: current.job && current.job.phase,
    tools: app.tools ? app.tools() : []
  };
  rendering = true;
  try {
    root.innerHTML = "<div class='spool-site-redesign' data-spool-site-root>" +
      topbar(path, current) +
      "<main class='redesign-main'>" + renderSitePage(path, context) + "</main>" +
      footer() +
      "</div>";
    document.title = pageTitle(path) + ' — SPOOL';
  } finally {
    rendering = false;
  }
}

function schedule() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(function () {
    queued = false;
    renderSite();
  });
}

function navigate(path) {
  if (!PATHS.has(path) && !path.startsWith('/studio')) return;
  if (window.location.pathname !== path) window.history.pushState({}, '', path);
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (PATHS.has(path)) renderSite();
  else window.dispatchEvent(new CustomEvent('spool:studio-route', { detail: { path: path } }));
}

document.addEventListener('click', function (event) {
  var link = event.target.closest && event.target.closest('[data-site-route]');
  if (!link) return;
  event.preventDefault();
  navigate(link.dataset.siteRoute);
}, true);

window.addEventListener('popstate', schedule);
window.addEventListener('spool:site-route', schedule);
window.addEventListener('spool:statechange', schedule);

var root = document.getElementById('app-root');
if (root) {
  var observer = new MutationObserver(function () {
    if (PATHS.has(rawPath()) && !rendering && !root.querySelector('[data-spool-site-root]')) schedule();
  });
  observer.observe(root, { childList: true });
}

var poll = window.setInterval(function () {
  if (PATHS.has(rawPath()) && api()) {
    window.clearInterval(poll);
    schedule();
  }
}, 40);
window.setTimeout(function () { window.clearInterval(poll); }, 15000);
if (api()) schedule();
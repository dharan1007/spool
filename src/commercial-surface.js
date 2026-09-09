const ASSESSMENT_URL = 'https://github.com/dharan1007/spool/issues/new?template=migration-assessment.yml';

function surface() {
  const section = document.createElement('section');
  section.id = 'production-readiness';
  section.className = 'production-surface';
  section.innerHTML = `
    <div class="production-surface__intro">
      <span class="production-surface__kicker">PRODUCTION CAPABILITY</span>
      <h2>Local-first CSV preparation plus a crash-safe CSV → SQLite execution path.</h2>
      <p>The browser Studio keeps rows local and is limited to 50 MiB inputs. The local runner executes approved UTF-8 CSV migrations into an existing ordinary SQLite table with target preflight, source snapshot binding, transactional batch evidence, fencing, reconciliation, verification and a commit-bound receipt.</p>
      <div class="production-surface__actions">
        <a class="button primary" href="${ASSESSMENT_URL}" target="_blank" rel="noopener noreferrer">Request a Migration Assessment →</a>
        <a class="button secondary" href="https://github.com/dharan1007/spool/tree/main/examples/crm-export" target="_blank" rel="noopener noreferrer">Inspect the CRM migration case</a>
      </div>
      <p class="production-surface__privacy">Public intake is metadata-only. Do not attach customer rows, database dumps, credentials or private URLs.</p>
    </div>
    <div class="production-surface__matrix" aria-label="SPOOL production support matrix">
      <article><span>SUPPORTED</span><strong>Browser Studio</strong><p>Local CSV profile, deterministic transform, validation, checkpoint recovery and safe export.</p></article>
      <article><span>SUPPORTED</span><strong>Local runner</strong><p>Filesystem UTF-8 CSV → existing ordinary SQLite table, insert mode, bound approval and verified receipt.</p></article>
      <article><span>FAILS CLOSED</span><strong>Safety boundaries</strong><p>Source drift, target-contract drift, stale writers, replay conflicts, triggers, path escapes and ambiguous dates/numbers.</p></article>
      <article><span>NOT CLAIMED</span><strong>Outside Gate B</strong><p>PostgreSQL/MySQL, upsert/replace/delete/truncate, virtual/triggered SQLite targets and hosted raw-row ingestion.</p></article>
    </div>`;
  return section;
}

function ensureSurface() {
  const root = document.getElementById('app-root');
  if (!root || document.getElementById('production-readiness')) return;
  const footer = root.querySelector('.footer');
  const section = surface();
  if (footer) footer.before(section);
  else root.append(section);
}

const observer = new MutationObserver(() => queueMicrotask(ensureSurface));
const root = document.getElementById('app-root');
if (root) observer.observe(root, { childList: true, subtree: false });
window.addEventListener('popstate', ensureSurface);
queueMicrotask(ensureSurface);

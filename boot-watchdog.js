(() => {
  const root = document.getElementById('app-root');
  if (!root) return;

  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled || window.__spoolTest) return;
    root.innerHTML = `<main class="boot-failure"><div class="boot-failure-card"><span class="brand-mark">S</span><span class="kicker">STARTUP TIMED OUT</span><h1>SPOOL could not finish loading.</h1><p>The browser did not complete the application module graph in time. This screen is independent of the main app, so a module-loading failure cannot leave a permanent loading shell.</p><pre>Startup timed out before SPOOL exposed its runtime.</pre><div class="hero-actions"><button class="button primary" id="boot-reload">Reload SPOOL</button><span>Check that JavaScript modules and IndexedDB are permitted for this site.</span></div></div></main>`;
    document.getElementById('boot-reload')?.addEventListener('click', () => window.location.reload());
  }, 12000);

  window.__spoolMarkBooted = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    delete window.__spoolMarkBooted;
  };
})();

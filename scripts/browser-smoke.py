#!/usr/bin/env python3
import base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTTP_PORT = 8876
CDP_PORT = 9336
with open(os.path.join(ROOT, 'package.json'), encoding='utf8') as package_file:
    RELEASE_TAG = f"v{json.load(package_file)['version']}"


def get_json(url, method='GET'):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=3) as response:
        return json.load(response)


def resolve_browser():
    configured = os.environ.get('SPOOL_BROWSER')
    if configured:
        resolved = shutil.which(configured) if os.path.sep not in configured else configured
        if resolved and os.path.exists(resolved):
            return resolved
        raise RuntimeError(f'SPOOL_BROWSER does not resolve to an executable: {configured}')
    for candidate in ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise RuntimeError('No supported Chromium/Chrome executable found')


def resolve_serve_dir():
    configured = os.environ.get('SPOOL_SERVE_DIR')
    if not configured:
        return ROOT
    path = configured if os.path.isabs(configured) else os.path.join(ROOT, configured)
    path = os.path.realpath(path)
    if not os.path.isdir(path):
        raise RuntimeError(f'SPOOL_SERVE_DIR is not a directory: {path}')
    return path


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=8)
        self.ident = 0
        self.events = []

    def call(self, method, params=None):
        self.ident += 1
        ident = self.ident
        self.ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') == ident:
                if 'error' in message:
                    raise RuntimeError(f"CDP {method}: {message['error']}")
                return message.get('result', {})
            self.events.append(message)

    def eval(self, expression):
        result = self.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result.get('result', {}).get('value')

    def close(self):
        self.ws.close()


def wait_for(fn, timeout=20, interval=.1, label='condition'):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(interval)
    raise AssertionError(f'Timed out waiting for {label}; last={last!r}')


def stop_process(process):
    if not process:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def launch_browser_with_cdp(browser, port=CDP_PORT):
    failures = []
    for attempt in range(1, 4):
        profile = tempfile.mkdtemp(prefix=f'spool-chrome-{attempt}-')
        browser_log = tempfile.NamedTemporaryFile(prefix=f'spool-browser-{attempt}-', suffix='.log', delete=False)
        browser_log_path = browser_log.name
        browser_log.close()
        log_handle = open(browser_log_path, 'w+', encoding='utf8')
        chrome = subprocess.Popen([
            browser,
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-background-networking',
            '--no-first-run',
            '--no-default-browser-check',
            '--remote-allow-origins=*',
            '--remote-debugging-address=127.0.0.1',
            f'--remote-debugging-port={port}',
            f'--user-data-dir={profile}',
            'about:blank'
        ], stdout=log_handle, stderr=log_handle)
        try:
            wait_for(lambda: get_json(f'http://127.0.0.1:{port}/json/version'), timeout=12, label=f'Chromium CDP attempt {attempt}')
            pages = get_json(f'http://127.0.0.1:{port}/json')
            if not any(page.get('type') == 'page' for page in pages):
                raise AssertionError('CDP opened without a page target')
            print(json.dumps({'cdpBootstrap': 'PASS', 'attempt': attempt, 'profile': os.path.basename(profile)}), flush=True)
            return chrome, profile, log_handle, browser_log_path
        except Exception as exc:
            status = chrome.poll()
            log_handle.flush()
            log_handle.seek(0)
            details = log_handle.read()[-8000:]
            failures.append({'attempt': attempt, 'exit': status, 'error': str(exc), 'log': details})
            stop_process(chrome)
            log_handle.close()
            try:
                os.unlink(browser_log_path)
            except OSError:
                pass
            shutil.rmtree(profile, ignore_errors=True)
            if attempt < 3:
                time.sleep(.5)

    raise AssertionError(f'Browser failed to expose CDP after 3 clean-profile attempts; executable={browser!r}; attempts={failures!r}')


def main():
    remote = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SPOOL_URL')
    server = None
    chrome = None
    profile = None
    log_handle = None
    browser_log_path = None
    cdp = None
    if remote:
        base_url = remote.rstrip('/')
        target = base_url + '/studio/new'
    else:
        serve_dir = resolve_serve_dir()
        server = subprocess.Popen(['python3', '-m', 'http.server', str(HTTP_PORT), '--directory', serve_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base_url = f'http://127.0.0.1:{HTTP_PORT}'
        target = base_url + '/'

    try:
        browser = resolve_browser()
        print(json.dumps({'browser': browser, 'target': target, 'serveDir': None if remote else resolve_serve_dir()}), flush=True)
        chrome, profile, log_handle, browser_log_path = launch_browser_with_cdp(browser)

        pages = get_json(f'http://127.0.0.1:{CDP_PORT}/json')
        page = next(p for p in pages if p.get('type') == 'page')
        cdp = CDP(page['webSocketDebuggerUrl'])
        cdp.call('Runtime.enable')
        cdp.call('Page.enable')
        cdp.call('Network.enable')
        cdp.call('Log.enable')

        cdp.call('Page.navigate', {'url': target})
        wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=20, label='initial page load')
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=15, label='SPOOL app bootstrap')

        product_checks = [
            ('/local-runner', f'npm install -g github:dharan1007/spool#{RELEASE_TAG}', 'spool receipt'),
            ('/examples', '5 source records', '3 valid'),
            ('/security', "connect-src 'none'", 'STALE_FENCE'),
            ('/services', 'DEPLOYMENT + SUPPORT', 'Production target writes stay local')
        ]
        for route, needle_a, needle_b in product_checks:
            cdp.call('Page.navigate', {'url': base_url + route})
            wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=15, label=f'{route} load')
            wait_for(lambda r=route: cdp.eval(f'document.querySelector("[data-product-route=\\"{r}\\"]") !== null'), timeout=15, label=f'{route} product surface')
            text = cdp.eval('document.body.innerText')
            assert needle_a in text, f'{route} missing {needle_a!r}'
            assert needle_b in text, f'{route} missing {needle_b!r}'
            assert 'Migration Preflight' not in text, f'{route} still exposes paid Hobby-hosted migration copy'
            assert 'Local-first migration demo' not in cdp.eval('document.title')

        cdp.call('Page.navigate', {'url': base_url + '/studio/new'})
        wait_for(lambda: cdp.eval('document.readyState === "complete"'), timeout=15, label='Studio deep-link load')
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=15, label='Studio bootstrap after product routes')
        assert cdp.eval('window.__spoolTest.state().job.phase') in ('EMPTY', 'COMPLETE')

        if cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'):
            cdp.eval('window.__spoolTest.invoke("start_new_migration", {})')
            wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "EMPTY"'), label='workspace reset')

        cdp.eval('window.__spoolTest.loadDemo()')
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "SOURCE_READY"'), timeout=15, label='demo source load')
        assert cdp.eval('window.__spoolTest.state().source.rows.length') == 25000

        result = cdp.eval('window.__spoolTest.runAutopilot("database_ready")')
        assert result['ok'] is True
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'), timeout=35, label='25k Autopilot completion')
        state = cdp.eval('window.__spoolTest.state()')
        assert state['job']['processedRows'] == 25000
        assert state['job']['validRows'] > 24900
        assert state['job']['invalidRows'] > 0
        assert state['mission']['status'] == 'COMPLETE_WITH_REJECTIONS'
        tools = cdp.eval('window.__spoolTest.tools()')
        assert 'export_csv' in tools and 'start_migration' not in tools

        cdp.eval('window.__spoolTest.navigate("/studio/results")')
        wait_for(lambda: cdp.eval('document.querySelectorAll(".result-metrics article").length === 4'), label='results UI')
        assert cdp.eval('document.querySelectorAll(".quality-grid article").length > 0')

        cdp.call('Page.reload', {'ignoreCache': True})
        wait_for(lambda: cdp.eval('Boolean(window.__spoolTest)'), timeout=15, label='reload bootstrap')
        wait_for(lambda: cdp.eval('window.__spoolTest.state().job.phase === "COMPLETE"'), timeout=10, label='IndexedDB restoration')
        assert cdp.eval('window.__spoolTest.state().output.length > 24900')
        assert cdp.eval('window.__spoolTest.state().mission.status') == 'COMPLETE_WITH_REJECTIONS'

        exceptions = [e for e in cdp.events if e.get('method') == 'Runtime.exceptionThrown']
        failed = [e for e in cdp.events if e.get('method') == 'Network.loadingFailed' and not e.get('params', {}).get('canceled')]
        severe_logs = [e for e in cdp.events if e.get('method') == 'Log.entryAdded' and e.get('params', {}).get('entry', {}).get('level') in ('error', 'warning')]
        if exceptions:
            raise AssertionError(f'Runtime exceptions: {exceptions[:3]}')
        if failed:
            raise AssertionError(f'Failed network loads: {failed[:3]}')
        if severe_logs:
            raise AssertionError(f'Browser error/warning logs: {severe_logs[:3]}')

        shot = cdp.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        screenshot_path = os.path.join(ROOT, 'browser-smoke.png')
        with open(screenshot_path, 'wb') as f:
            f.write(base64.b64decode(shot['data']))
        print(json.dumps({
            'status': 'PASS',
            'url': target,
            'productRoutes': [route for route, _, _ in product_checks],
            'rows': state['job']['processedRows'],
            'valid': state['job']['validRows'],
            'invalid': state['job']['invalidRows'],
            'phase': state['job']['phase'],
            'mission': state['mission']['status'],
            'tools': tools,
            'recovery': 'PASS',
            'runtimeExceptions': 0,
            'failedNetworkLoads': 0,
            'screenshot': screenshot_path
        }, indent=2))
    finally:
        if cdp:
            cdp.close()
        stop_process(chrome)
        if log_handle:
            log_handle.close()
        if browser_log_path:
            try:
                os.unlink(browser_log_path)
            except OSError:
                pass
        if server:
            stop_process(server)
        if profile:
            shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    main()
